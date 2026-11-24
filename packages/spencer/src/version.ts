import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let pkgVersion: string | undefined;

/**
 * Running Spencer version:
 *  - SEA single binary: `process.env.SPENCER_BUILD` baked in at bundle time (e.g. `0.1.5+abc1234`)
 *  - Nix wrapper: `SPENCER_BUILD` env var (e.g. `0.1.5`)
 *  - Source / npm: `version` from `packages/spencer/package.json`
 */
export function spencerVersion(): string {
  const build = process.env.SPENCER_BUILD?.trim();
  if (build) return build;
  if (pkgVersion) return pkgVersion;
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const v = JSON.parse(readFileSync(pkgPath, "utf8"))?.version;
    if (typeof v === "string" && v.trim()) return (pkgVersion = v.trim());
  } catch {
    /* bundled or missing package.json */
  }
  return "dev";
}
