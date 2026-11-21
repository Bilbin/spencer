import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadP2pAddon } from "../../src/p2p/addon.ts";

test("loads the installed addon and an unpacked copy, and reports missing files", () => {
  const installed = loadP2pAddon();
  assert.equal(installed.ok, true);
  if (!installed.ok) return;
  const dir = mkdtempSync(join(tmpdir(), "spencer-addon-"));
  try {
    const copy = join(dir, "addon.node");
    copyFileSync(installed.path, copy);
    assert.equal(loadP2pAddon(copy).ok, true);
    const missing = loadP2pAddon(join(dir, "missing.node"));
    assert.equal(missing.ok, false);
    const corrupt = join(dir, "corrupt.node");
    writeFileSync(corrupt, Buffer.from("not a native addon"));
    const bad = loadP2pAddon(corrupt);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.ok(bad.error);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
