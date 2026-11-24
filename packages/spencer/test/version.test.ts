import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spencerVersion } from "../src/version.ts";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgVersion = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version as string;

test("spencerVersion prefers SPENCER_BUILD and falls back to package.json", () => {
  const prev = process.env.SPENCER_BUILD;
  try {
    delete process.env.SPENCER_BUILD;
    assert.equal(spencerVersion(), pkgVersion);
    process.env.SPENCER_BUILD = "9.9.9+testsha";
    assert.equal(spencerVersion(), "9.9.9+testsha");
  } finally {
    if (prev === undefined) delete process.env.SPENCER_BUILD;
    else process.env.SPENCER_BUILD = prev;
  }
});

test("CLI --version, -v, and -V print the resolved version", () => {
  const main = join(pkgRoot, "src/main.ts");
  for (const flag of ["--version", "-v", "-V"]) {
    const out = execFileSync(process.execPath, [main, flag], {
      encoding: "utf8",
      env: { ...process.env, SPENCER_BUILD: "" },
    });
    assert.match(out, new RegExp(`^spencer ${pkgVersion.replaceAll(".", "\\.")} \\(node `));
  }
});
