/**
 * Model sign-ins (OAuth credentials) saved across restarts: `<dataDir>/secrets/credentials.json`, mode 0600,
 * one credential per pi-ai provider id. API keys from config.json / model.env never land here; they stay in
 * memory (see models.ts).
 *
 * Only one daemon runs per data dir (store/lock.ts), so serializing writes in-process is enough. Each write
 * goes to a temp file and is renamed into place, so a crash never leaves half a file.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export class FileCredentialStore implements CredentialStore {
  readonly file: string;
  private data: Record<string, Credential>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    const dir = join(dataDir, "secrets");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "credentials.json");
    this.data = {};
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) this.data = raw as Record<string, Credential>;
      } catch {
        // A corrupt file must not take the daemon down; the owner signs in again and it is rewritten.
        this.data = {};
      }
      try {
        chmodSync(this.file, 0o600);
      } catch {
        /* best effort */
      }
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private save(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return Object.hasOwn(this.data, providerId) ? this.data[providerId] : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.data).map(([providerId, c]) => ({ providerId, type: c.type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const current = Object.hasOwn(this.data, providerId) ? this.data[providerId] : undefined;
      const next = await fn(current);
      if (next === undefined) return current;
      this.data = { ...this.data, [providerId]: next };
      this.save();
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!Object.hasOwn(this.data, providerId)) return;
      const { [providerId]: _gone, ...rest } = this.data;
      this.data = rest;
      this.save();
    });
  }
}
