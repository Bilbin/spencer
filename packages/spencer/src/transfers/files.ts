import { createHash } from "node:crypto";
import { createReadStream, constants as fsc, chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface Dirs {
  outgoing: string;
  incoming: string;
  quarantine: string;
}

export function dirsFor(dataDir: string): Dirs {
  return {
    outgoing: join(dataDir, "outgoing"),
    incoming: join(dataDir, "incoming"),
    quarantine: join(dataDir, "quarantine"),
  };
}

/** mkdir -p with mode 0700 on every directory we create (umask-proof). */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export async function ensureDirAsync(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(file);
    s.on("data", (d) => h.update(d));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/** Copies src → dest (reflink when the filesystem supports it), mode 0600. Returns the copy's size. */
export async function stageCopy(src: string, dest: string): Promise<number> {
  await copyFile(src, dest, fsc.COPYFILE_FICLONE);
  await chmod(dest, 0o600);
  return (await stat(dest)).size;
}

export function rmrf(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Total bytes of regular files directly or indirectly under dir (no symlink following). */
export function dirBytes(dir: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      const st = lstatSync(p);
      if (st.isDirectory()) total += dirBytes(p);
      else if (st.isFile()) total += st.size;
    } catch {
      /* raced with deletion */
    }
  }
  return total;
}

export type ReceivedFile =
  | { kind: "none" }
  | { kind: "file"; path: string; size: number }
  | { kind: "unexpected"; reason: string };

/** Finds the single regular file croc wrote into dir. */
export function findReceived(dir: string): ReceivedFile {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { kind: "none" };
  }
  if (entries.length === 0) return { kind: "none" };
  if (entries.length > 1) return { kind: "unexpected", reason: `expected one file, got ${entries.length} entries` };
  const p = join(dir, entries[0].name);
  const st = lstatSync(p);
  if (!st.isFile()) return { kind: "unexpected", reason: "received entry is not a regular file" };
  return { kind: "file", path: p, size: st.size };
}
