/**
 * Support for running as a single-file binary (Node "single executable application", built by
 * scripts/build-binary.mjs). The binary embeds the web UI and the pinned croc as SEA assets plus a
 * manifest; on start they are unpacked once into a per-build cache directory, because the HTTP server
 * serves files from disk and croc must be an executable file.
 *
 * Outside a binary (`node packages/spencer/src/main.ts`, nix) everything here is a no-op.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";

interface SeaApi {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
  getAsset(key: string, encoding: string): string;
}

/** The asset manifest written by the build: `build` changes whenever any embedded file changes. */
export interface SeaManifest {
  version: string;
  build: string;
  files: string[]; // asset keys under "web/"
  croc?: string; // asset key of the croc executable, if embedded
}

export interface Embedded {
  version: string;
  webRoot: string;
  croc?: string;
}

function sea(): SeaApi | undefined {
  try {
    const mod = process.getBuiltinModule?.("node:sea") as SeaApi | undefined;
    return mod?.isSea() ? mod : undefined;
  } catch {
    return undefined;
  }
}

export function isBinary(): boolean {
  return sea() !== undefined;
}

export function cacheBase(): string {
  if (process.env.SPENCER_CACHE_DIR) return process.env.SPENCER_CACHE_DIR;
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "spencer");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "spencer", "cache");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "spencer");
}

let cached: Embedded | null | undefined;

/** Unpacks the embedded files (once per build) and returns their paths; undefined when not a binary. */
export function embedded(): Embedded | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const api = sea();
  if (!api) {
    cached = null;
    return undefined;
  }
  const manifest = JSON.parse(api.getAsset("manifest.json", "utf8")) as SeaManifest;
  if (!/^[0-9a-f]{8,64}$/.test(manifest.build)) throw new Error("binary manifest has a bad build id");
  const base = cacheBase();
  const dir = join(base, manifest.build);
  const exe = process.platform === "win32" ? "croc.exe" : "croc";
  const done = join(dir, ".complete");
  if (!existsSync(done)) {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    // Unpack into a private temp dir, then rename into place, so a crash never leaves a half-written tree
    // that a later start would trust.
    const tmp = `${dir}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { mode: 0o700 });
    for (const key of manifest.files) {
      if (!key.startsWith("web/")) continue;
      const target = normalize(join(tmp, key));
      if (!target.startsWith(tmp + sep)) throw new Error(`binary manifest has a bad path: ${key}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(api.getAsset(key)), { mode: 0o644 });
    }
    if (manifest.croc) {
      writeFileSync(join(tmp, exe), Buffer.from(api.getAsset(manifest.croc)), { mode: 0o755 });
      chmodSync(join(tmp, exe), 0o755);
    }
    writeFileSync(join(tmp, ".complete"), manifest.version + "\n");
    try {
      renameSync(tmp, dir);
    } catch (e) {
      // Another instance won the race; use its copy.
      rmSync(tmp, { recursive: true, force: true });
      if (!existsSync(done)) throw e;
    }
  }
  cached = { version: manifest.version, webRoot: join(dir, "web"), ...(manifest.croc ? { croc: join(dir, exe) } : {}) };
  return cached;
}
