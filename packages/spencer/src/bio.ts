import { closeSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_ABOUT, truncateUtf16 } from "@spencer/protocol";
import { UserError } from "./channels.ts";

/** At most 4 UTF-8 bytes per UTF-16 code unit, plus slack for surrounding whitespace. */
const MAX_BIO_READ_BYTES = (MAX_ABOUT + 64) * 4;

export function readBio(dataDir: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(join(dataDir, "BIO.md"), "r");
    const buf = Buffer.alloc(MAX_BIO_READ_BYTES);
    const n = readSync(fd, buf, 0, MAX_BIO_READ_BYTES, 0);
    const text = new TextDecoder().decode(buf.subarray(0, n)).replace(/\uFFFD+$/, "").trim();
    return truncateUtf16(text, MAX_ABOUT);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeBio(dataDir: string, value: unknown): void {
  if (typeof value !== "string") throw new UserError(400, "text must be a string");
  const text = value.trim();
  if (text.length > MAX_ABOUT) throw new UserError(400, `BIO.md exceeds ${MAX_ABOUT} chars`);
  const file = join(dataDir, "BIO.md");
  if (!text) { rmSync(file, { force: true }); return; }
  const temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" }); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}
