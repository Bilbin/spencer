import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_ABOUT } from "@spencer/protocol";
import { UserError } from "./channels.ts";

export function readBio(dataDir: string): string {
  try { return readFileSync(join(dataDir, "BIO.md"), "utf8").trim(); }
  catch (e) { if (e instanceof Error && "code" in e && e.code === "ENOENT") return ""; throw e; }
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
