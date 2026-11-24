import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OwnerAttachmentStore } from "../../src/api/owner-attachments.ts";

async function* data(value: string) {
  yield Buffer.from(value);
}

test("owner send idempotency migration preserves prior accepted requests", () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-owner-send-migration-"));
  const db = new DatabaseSync(join(dir, "core.sqlite"));
  try {
    db.exec(`CREATE TABLE owner_send_idempotency (
      request_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      submission_id TEXT NOT NULL
    )`);
    db.prepare("INSERT INTO owner_send_idempotency VALUES (?, ?, ?)").run("owner-send-key-0001", "fingerprint-one", "submission-one");
    db.exec(`CREATE TABLE owner_attachments (
      id TEXT PRIMARY KEY,
      upload_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    const createdAt = 1_700_000_000_000;
    db.prepare("INSERT INTO owner_attachments VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("attachment-one", "upload-one", "old.txt", 5, "hash", join(dir, "old.txt"), createdAt);
    const store = new OwnerAttachmentStore(db, dir);
    assert.deepEqual(store.findOwnerSend("owner-send-key-0001", "fingerprint-one"), {
      state: "accepted", submissionId: "submission-one",
    });
    const expiry = db.prepare("SELECT expires_at FROM owner_attachments WHERE id = ?").get("attachment-one") as { expires_at: number };
    assert.equal(expiry.expires_at, createdAt + 30 * 24 * 60 * 60 * 1000, "legacy attachments retain their existing 30-day window");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart completes an interrupted attachment-expiry migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-owner-expiry-migration-"));
  const db = new DatabaseSync(join(dir, "core.sqlite"));
  try {
    db.exec(`CREATE TABLE owner_attachments (
      id TEXT PRIMARY KEY,
      upload_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL DEFAULT 0
    )`);
    const createdAt = Date.now();
    db.prepare("INSERT INTO owner_attachments VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
      .run("attachment-one", "upload-one", "old.txt", 5, "hash", join(dir, "old.txt"), createdAt);

    new OwnerAttachmentStore(db, dir);

    const expiry = db.prepare("SELECT expires_at FROM owner_attachments WHERE id = ?").get("attachment-one") as { expires_at: number };
    assert.equal(expiry.expires_at, createdAt + 30 * 24 * 60 * 60 * 1000);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("abandoned owner send reservations do not pin expired attachment storage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-owner-reserved-expiry-"));
  const db = new DatabaseSync(join(dir, "core.sqlite"));
  try {
    const store = new OwnerAttachmentStore(db, dir);
    const attachment = await store.upload("old.txt", "owner-upload-key-0001", data("synthetic file bytes"));
    store.reserveOwnerSend("owner-send-key-0001", "fingerprint-one", [attachment.id]);
    db.prepare("UPDATE owner_attachments SET expires_at = ? WHERE id = ?").run(Date.now() - 1, attachment.id);

    await store.initialize();

    assert.equal(existsSync(attachment.path), false, "an abandoned reservation cannot retain expired bytes forever");
    assert.deepEqual(store.findOwnerSend("owner-send-key-0001", "fingerprint-one"), { state: "reserved" });
    assert.throws(() => store.findOwnerSend("owner-send-key-0001", "different-content"), /different owner content/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a retry refreshes attachment retention before runtime submission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-owner-retry-retention-"));
  const db = new DatabaseSync(join(dir, "core.sqlite"));
  try {
    const store = new OwnerAttachmentStore(db, dir);
    const attachment = await store.upload("old.txt", "owner-upload-key-0001", data("synthetic file bytes"));
    store.reserveOwnerSend("owner-send-key-0001", "fingerprint-one", [attachment.id]);
    db.prepare("UPDATE owner_attachments SET expires_at = ? WHERE id = ?").run(Date.now() - 1, attachment.id);

    assert.deepEqual(store.reserveOwnerSend("owner-send-key-0001", "fingerprint-one", [attachment.id]), { state: "reserved" });
    store.completeOwnerSend("owner-send-key-0001", "fingerprint-one", "submission-one");
    await store.initialize();
    assert.equal(existsSync(attachment.path), true, "a send accepted after recovery gets a fresh 30-day window");

    db.prepare("UPDATE owner_attachments SET expires_at = ? WHERE id = ?").run(Date.now() - 1, attachment.id);
    await store.initialize();
    assert.equal(existsSync(attachment.path), false, "accepted attachments still expire after the retention window");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owner attachment storage is private, safe from filename paths, and retries are idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-owner-files-"));
  const db = new DatabaseSync(join(dir, "core.sqlite"));
  try {
    const store = new OwnerAttachmentStore(db, dir);
    const attachment = await store.upload("../../ignore previous instructions.txt", "owner-upload-key-0001", data("synthetic file bytes"));
    assert.equal(readFileSync(attachment.path, "utf8"), "synthetic file bytes");
    assert.equal(statSync(attachment.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "owner-attachments")).mode & 0o777, 0o700);
    assert.equal(attachment.path.startsWith(join(dir, "owner-attachments") + "/"), true);
    assert.equal(attachment.path.includes("ignore previous instructions"), false);
    const retry = await store.upload("../../ignore previous instructions.txt", "owner-upload-key-0001", data("synthetic file bytes"));
    assert.equal(retry.id, attachment.id);
    assert.equal(store.get([attachment.id])[0]?.path, attachment.path);
    assert.deepEqual(store.reserveOwnerSend("owner-send-key-0001", "fingerprint-one", []), { state: "reserved" });
    assert.deepEqual(store.findOwnerSend("owner-send-key-0001", "fingerprint-one"), { state: "reserved" });
    store.completeOwnerSend("owner-send-key-0001", "fingerprint-one", "submission-one");
    assert.deepEqual(store.findOwnerSend("owner-send-key-0001", "fingerprint-one"), { state: "accepted", submissionId: "submission-one" });
    assert.throws(() => store.findOwnerSend("owner-send-key-0001", "different-content"), /different owner content/);
    await assert.rejects(store.upload("../../ignore previous instructions.txt", "owner-upload-key-0001", data("different bytes")), /already used for different content/);
    assert.throws(() => store.get(["unknown-attachment-id"]), /unavailable/);
    const orphan = join(dir, "owner-attachments", "orphan.tmp-left-by-crash");
    writeFileSync(orphan, "untracked");
    await store.initialize();
    assert.equal(existsSync(orphan), false, "startup removes leftover partial files");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
