#!/usr/bin/env node
// Bundles the relay into a single ESM file: dist/relay/relay.mjs.
// Deploy: copy that file to /opt/spencer-relay/relay.mjs and run it with Node 22.18+.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { statSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist/relay/relay.mjs");

await build({
  entryPoints: [join(root, "packages/relay/src/main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Optional native accelerators of ws; it falls back to JS when they are missing.
  external: ["bufferutil", "utf-8-validate"],
  // ws is CommonJS and calls require() for Node builtins and the optional deps above.
  banner: { js: 'import { createRequire as __spencerCreateRequire } from "node:module"; const require = __spencerCreateRequire(import.meta.url);' },
  legalComments: "none",
  sourcemap: false,
  minify: false,
  logLevel: "warning",
});

console.log(`built ${outfile} (${(statSync(outfile).size / 1024).toFixed(0)} KiB)`);
