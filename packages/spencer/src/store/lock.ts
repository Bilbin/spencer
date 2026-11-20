import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export class DataDirLockedError extends Error {
  readonly pid: number;
  constructor(dir: string, pid: number) {
    super(`another Spencer is using this data dir (${dir}, pid ${pid})`);
    this.name = "DataDirLockedError";
    this.pid = pid;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: exists but belongs to someone else, so treat it as alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface DataDirLock {
  readonly path: string;
  release(): void;
}

/**
 * Single-writer lock: `<dataDir>/spencer.lock` created with O_EXCL and containing the pid.
 * A lock left by a dead process is taken over. A lock held by this very process (a second Daemon
 * in the same process on the same dir) is refused too.
 */
export function acquireLock(dataDir: string): DataDirLock {
  const path = join(dataDir, "spencer.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          try {
            if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let pid = NaN;
    try {
      pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    } catch {
      /* vanished or unreadable: retry */
    }
    if (pidAlive(pid)) throw new DataDirLockedError(dataDir, pid);
    // Stale: remove and retry. Two processes racing here both unlink, and only one wins the `wx` create.
    try {
      unlinkSync(path);
    } catch {
      /* someone else removed it */
    }
  }
  throw new Error(`could not acquire lock ${path}`);
}
