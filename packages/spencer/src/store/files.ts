import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { generateIdentity, identityFromSecret, type Identity } from "@spencer/protocol";

/** Atomic write with mode 0600. */
export function writeSecretFile(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
}

/** `<dataDir>/identity.json` ({id, secret}), generated on first start. */
export function loadOrCreateIdentity(dataDir: string): Identity {
  const file = join(dataDir, "identity.json");
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { id?: string; secret?: string };
    if (typeof raw.secret !== "string") throw new Error(`${file}: missing secret`);
    const id = identityFromSecret(raw.secret);
    if (raw.id !== undefined && raw.id !== id.id) throw new Error(`${file}: id does not match secret`);
    return id;
  }
  const id = generateIdentity();
  writeSecretFile(file, JSON.stringify({ v: 1, id: id.id, secret: id.secret, createdAt: Date.now() }, null, 2) + "\n");
  return id;
}

/** `<dataDir>/api-token`: 32 random bytes hex, stable across restarts. */
export function loadOrCreateToken(dataDir: string): string {
  const file = join(dataDir, "api-token");
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  }
  const t = randomBytes(32).toString("hex");
  writeSecretFile(file, t + "\n");
  return t;
}
