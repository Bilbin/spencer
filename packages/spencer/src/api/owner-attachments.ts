import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { OwnerAttachment } from "../contracts.ts";

export const OWNER_ATTACHMENT_MAX_FILES = 10;
export const OWNER_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
export const OWNER_ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const OWNER_ATTACHMENT_MAX_STORED_BYTES = 500 * 1024 * 1024;
const OWNER_ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredAttachment extends OwnerAttachment {
  path: string;
  sha256: string;
  uploadId: string;
  createdAt: number;
}

export type OwnerSendState =
  | { state: "reserved" }
  | { state: "accepted"; submissionId: string };

export class OwnerSendConflict extends Error {
  constructor() {
    super("request ID was already used for different owner content");
    this.name = "OwnerSendConflict";
  }
}

/** Private, local-only storage for owner conversation attachments (never a channel transfer). */
export class OwnerAttachmentStore {
  private readonly db: DatabaseSync;
  private readonly dir: string;
  private pendingBytes = 0;

  constructor(db: DatabaseSync, dataDir: string) {
    this.db = db;
    this.dir = join(dataDir, "owner-attachments");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_send_idempotency (
        request_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'accepted'
      );
      CREATE TABLE IF NOT EXISTS owner_attachments (
        id TEXT PRIMARY KEY,
        upload_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(owner_send_idempotency)").all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("state")) {
      this.db.exec("ALTER TABLE owner_send_idempotency ADD COLUMN state TEXT NOT NULL DEFAULT 'accepted'");
    }
    const attachmentColumns = this.db.prepare("PRAGMA table_info(owner_attachments)").all() as { name: string }[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!attachmentColumns.some((column) => column.name === "expires_at")) {
        this.db.exec("ALTER TABLE owner_attachments ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0");
      }
      // Also repairs a shutdown after the column was added but before its old rows were backfilled.
      this.db.prepare("UPDATE owner_attachments SET expires_at = created_at + ? WHERE expires_at = 0").run(OWNER_ATTACHMENT_TTL_MS);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async initialize(): Promise<void> {
    await this.cleanupExpired();
    const rows = this.db.prepare("SELECT path FROM owner_attachments").all() as { path: string }[];
    const known = new Set(rows.map((row) => row.path));
    for (const entry of await readdir(this.dir)) {
      const path = join(this.dir, entry);
      if (entry.includes(".tmp-") || !known.has(path)) await rm(path, { force: true });
    }
  }

  private async cleanupExpired(): Promise<void> {
    // Expiration is bounded even for abandoned reservations; each send/retry renews it before the runtime side effect.
    const now = Date.now();
    const expired = this.db.prepare("SELECT id, path FROM owner_attachments WHERE expires_at < ?").all(now) as { id: string; path: string }[];
    const paths: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of expired) {
        const removed = this.db.prepare("DELETE FROM owner_attachments WHERE id = ? AND expires_at < ?").run(item.id, now);
        if (Number(removed.changes) > 0) paths.push(item.path);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    await Promise.all(paths.map((path) => rm(path, { force: true })));
  }

  findOwnerSend(requestId: string, fingerprint: string): OwnerSendState | undefined {
    const row = this.db.prepare("SELECT fingerprint, submission_id, state FROM owner_send_idempotency WHERE request_id = ?").get(requestId) as
      | { fingerprint: string; submission_id: string; state: string }
      | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new OwnerSendConflict();
    if (row.state === "accepted" && row.submission_id) return { state: "accepted", submissionId: row.submission_id };
    if (row.state === "reserved") return { state: "reserved" };
    throw new Error("owner send idempotency record is invalid");
  }

  reserveOwnerSend(requestId: string, fingerprint: string, attachmentIds: string[]): OwnerSendState {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO owner_send_idempotency (request_id, fingerprint, submission_id, state)
        VALUES (?, ?, '', 'reserved')
      `).run(requestId, fingerprint);
      const row = this.db.prepare("SELECT fingerprint, submission_id, state FROM owner_send_idempotency WHERE request_id = ?").get(requestId) as
        | { fingerprint: string; submission_id: string; state: string }
        | undefined;
      if (!row) throw new Error("owner send reservation was not stored");
      if (row.fingerprint !== fingerprint) throw new OwnerSendConflict();
      let state: OwnerSendState;
      if (row.state === "accepted" && row.submission_id) {
        state = { state: "accepted", submissionId: row.submission_id };
      } else if (row.state === "reserved") {
        state = { state: "reserved" };
      } else {
        throw new Error("owner send idempotency record is invalid");
      }
      // Renew attached bytes for reserved sends and accepted identical retries. Missing rows after cleanup are a no-op.
      const touch = this.db.prepare("UPDATE owner_attachments SET expires_at = ? WHERE id = ?");
      const expiresAt = Date.now() + OWNER_ATTACHMENT_TTL_MS;
      for (const attachmentId of attachmentIds) touch.run(expiresAt, attachmentId);
      this.db.exec("COMMIT");
      return state;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeOwnerSend(requestId: string, fingerprint: string, submissionId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT fingerprint, submission_id, state FROM owner_send_idempotency WHERE request_id = ?").get(requestId) as
        | { fingerprint: string; submission_id: string; state: string }
        | undefined;
      if (!row || row.fingerprint !== fingerprint) throw new Error("owner send reservation does not match its result");
      if (row.state === "accepted") {
        if (row.submission_id !== submissionId) throw new Error("owner send result changed for the same request ID");
      } else if (row.state === "reserved") {
        // Keep the request binding indefinitely, but let its files expire on the attachment retention schedule.
        this.db.prepare(`
          UPDATE owner_send_idempotency
          SET submission_id = ?, state = 'accepted'
          WHERE request_id = ? AND fingerprint = ? AND state = 'reserved'
        `).run(submissionId, requestId, fingerprint);
      } else {
        throw new Error("owner send idempotency record is invalid");
      }
      const completed = this.db.prepare("SELECT submission_id, state FROM owner_send_idempotency WHERE request_id = ?").get(requestId) as
        | { submission_id: string; state: string }
        | undefined;
      if (!completed || completed.state !== "accepted" || completed.submission_id !== submissionId) {
        throw new Error("owner send result was not stored");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async upload(name: string, uploadId: string, bytes: AsyncIterable<Uint8Array>): Promise<StoredAttachment> {
    await this.cleanupExpired();
    const id = randomUUID();
    const path = join(this.dir, id);
    const temp = `${path}.tmp-${randomUUID()}`;
    let reserved = 0;
    try {
      const file = await open(temp, "wx", 0o600);
      let size = 0;
      const hash = createHash("sha256");
      try {
        for await (const chunk of bytes) {
          size += chunk.byteLength;
          if (size > OWNER_ATTACHMENT_MAX_FILE_BYTES) throw new Error("file exceeds the 25 MiB upload limit");
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const result = await file.write(chunk, offset, chunk.byteLength - offset);
            if (result.bytesWritten === 0) throw new Error("could not write attachment");
            offset += result.bytesWritten;
          }
        }
      } finally {
        await file.close();
      }
      const sha256 = hash.digest("hex");
      const existing = this.db.prepare("SELECT * FROM owner_attachments WHERE upload_id = ?").get(uploadId) as Record<string, unknown> | undefined;
      if (existing) {
        if (existing.name !== name || existing.sha256 !== sha256 || Number(existing.size) !== size) throw new Error("upload id was already used for different content");
        return this.fromRow(existing);
      }
      const stored = Number((this.db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM owner_attachments").get() as { total: number }).total);
      if (stored + this.pendingBytes + size > OWNER_ATTACHMENT_MAX_STORED_BYTES) throw new Error("private attachment storage is full; remove older attachments first");
      this.pendingBytes += size;
      reserved = size;
      await rename(temp, path);
      const createdAt = Date.now();
      const expiresAt = createdAt + OWNER_ATTACHMENT_TTL_MS;
      try {
        this.db.prepare("INSERT INTO owner_attachments (id, upload_id, name, size, sha256, path, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, uploadId, name, size, sha256, path, createdAt, expiresAt);
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
      return { id, uploadId, name, size, sha256, path, createdAt };
    } finally {
      this.pendingBytes -= reserved;
      await rm(temp, { force: true });
    }
  }

  get(ids: string[]): StoredAttachment[] {
    const found = ids.map((id) => {
      const row = this.db.prepare("SELECT * FROM owner_attachments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? this.fromRow(row) : undefined;
    });
    if (found.some((item) => !item)) throw new Error("one or more attachments are unavailable; keep the drafts and retry");
    const items = found as StoredAttachment[];
    if (items.length > OWNER_ATTACHMENT_MAX_FILES || items.reduce((n, item) => n + item.size, 0) > OWNER_ATTACHMENT_MAX_BYTES) {
      throw new Error("the composer allows up to 10 files and 50 MiB at a time");
    }
    return items;
  }

  private fromRow(row: Record<string, unknown>): StoredAttachment {
    return {
      id: String(row.id), uploadId: String(row.upload_id), name: String(row.name), size: Number(row.size),
      sha256: String(row.sha256), path: String(row.path), createdAt: Number(row.created_at),
    };
  }
}
