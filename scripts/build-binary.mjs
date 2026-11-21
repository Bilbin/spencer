#!/usr/bin/env node
// Builds Spencer as one self-contained executable: no Node, npm, croc or systemd needed on the target.
//
//   node scripts/build-binary.mjs [--target linux-x64|linux-arm64|darwin-arm64|darwin-x64|all]
//
// Output: dist/binary/spencer-<target> (plus a .sha256 next to it).
//
// How: esbuild bundles packages/spencer/src/main.ts into one CommonJS file (Node 24's single executable
// applications only run CommonJS), the web UI and the pinned croc for the target become SEA assets
// (packages/spencer/src/sea.ts unpacks them on first run), and the blob is injected into the official
// Node binary for the target, downloaded from nodejs.org and checked against a pinned sha256.
// The blob is produced by the Node running this script, so it must be the pinned NODE_VERSION.
// macOS binaries must be re-signed after injection: done with `codesign` on a Mac or `rcodesign`
// (apple-codesign) elsewhere; without either, the darwin binary is left unsigned and the script says so.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const NODE_VERSION = "24.12.0";
const NODE_SHA256 = {
  "linux-x64": "6159227e0af7d7c3c6bb2fa900452b04a6cb8841a702a79acc613209d70b04d0",
  "linux-arm64": "9b2a2eeb98a8eb37361224e2a1d060300ad2dd143af58dfdb16de785df0f1228",
  "darwin-arm64": "319f221adc5e44ff0ed57e8a441b2284f02b8dc6fc87b8eb92a6a93643fd8080",
  "darwin-x64": "b82ea4c62fd08e250cab59d625e75d77cc5b0a3d60c6698ebee4545c88a169c5",
};
const CROC_VERSION = "v10.3.1";
const CROC = {
  "linux-x64": ["Linux-64bit", "52e6c2c510915c92c436f0098c8ce75d7e4660f74f0eeb9f9fd2cea5b9ff2e26"],
  "linux-arm64": ["Linux-ARM64", "18c71d91547f03bd52f4c13d146aca1df3a8ce5c205c5758a4fb0ad6f0de1821"],
  "darwin-arm64": ["macOS-ARM64", "4e8a2fb7e2e5bb5091567dbf7a0a2cb404fb25227d7688c755b8340bd9ead2ef"],
  "darwin-x64": ["macOS-64bit", "169aec647b8078ceb34d600d4cbff57d93fa849404b9d943a8e6e42b910984a0"],
};
const ADDONS = {
  "linux-x64": ["linux-x64-gnu", "0174d33d56968a9be4279f0d33e60bdf45adc3d42dabc2b5e174a85e9b7fc59c"],
  "linux-arm64": ["linux-arm64-gnu", "a9e451948865371bd31670b4566b325b98a4e4ed3d02c5af501f3874296bb01c"],
  "darwin-arm64": ["darwin-arm64", "76cc03f43db90340868380e18aa2b4871c6e9ac9f949f7085533a2dde3a03abc"],
  "darwin-x64": ["darwin-x64", "d442113813baab39f78ed1c0739ae17a9775fac2b4cf17ad0f563849733b4dc2"],
};
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist/binary");
const cache = join(out, "cache");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const log = (m) => console.log(`build-binary: ${m}`);

const { values } = parseArgs({ options: { target: { type: "string" } } });
const host = `${process.platform}-${process.arch}`;
const targets = values.target === "all" ? Object.keys(NODE_SHA256) : [values.target ?? host];
for (const t of targets) if (!NODE_SHA256[t]) throw new Error(`unknown target ${t}; one of ${Object.keys(NODE_SHA256).join(", ")}, all`);
if (process.versions.node !== NODE_VERSION) {
  throw new Error(`run this with Node ${NODE_VERSION} (the blob format must match the embedded Node); this is ${process.versions.node}`);
}
const version = JSON.parse(readFileSync(join(root, "packages/spencer/package.json"), "utf8")).version;
let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  /* not a git checkout */
}

mkdirSync(cache, { recursive: true });

/** Downloads `url` into the cache (once) and checks its sha256. */
async function fetchPinned(url, want) {
  const file = join(cache, url.split("/").pop());
  if (!existsSync(file) || sha256(readFileSync(file)) !== want) {
    log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha256(buf);
    if (got !== want) throw new Error(`${url}: sha256 ${got}, expected ${want}`);
    writeFileSync(file, buf);
  }
  return file;
}

/** Extracts one member of a tarball into a fresh dir and returns its path. */
function untar(tarball, member, into) {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", into, member]);
  return join(into, member);
}

// 1. One CommonJS bundle of the daemon (shared by every target: it is plain JS).
const bundle = join(out, "spencer.cjs");
await build({
  entryPoints: [join(root, "packages/spencer/src/main.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  // Optional native accelerators of ws; it falls back to JS when they are missing.
  external: ["bufferutil", "utf-8-validate", "node-datachannel", "@node-datachannel/*"],
  // A few dependencies read import.meta.url (resolving files next to themselves); point it at the binary.
  define: { "import.meta.url": "__spencerImportMetaUrl", "process.env.SPENCER_BUILD": JSON.stringify(`${version}+${commit}`) },
  banner: {
    js: [
      'const __spencerImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
      // node:sqlite is stable enough for us; its ExperimentalWarning only confuses people running the binary.
      "{ const emit = process.emitWarning; process.emitWarning = function (w, ...a) { const t = typeof a[0] === 'string' ? a[0] : a[0] && a[0].type; if ((t === 'ExperimentalWarning' || (w && w.name === 'ExperimentalWarning')) && /SQLite/.test(String(w && w.message ? w.message : w))) return; return emit.call(process, w, ...a); }; }",
    ].join("\n"),
  },
  legalComments: "none",
  logLevel: "warning",
});
log(`bundled ${relative(root, bundle)} (${(statSync(bundle).size / 1048576).toFixed(1)} MiB)`);

// 2. The web UI as assets.
const webDir = join(root, "packages/web/public");
const webFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else webFiles.push(p);
  }
})(webDir);

let postject;
for (const target of targets) {
  const [os] = target.split("-");
  const exe = join(out, `spencer-${target}`);
  const work = join(cache, `work-${target}`);

  // 3. Pinned croc for the target.
  const [crocAsset, crocSha] = CROC[target];
  const crocTar = await fetchPinned(`https://github.com/schollz/croc/releases/download/${CROC_VERSION}/croc_${CROC_VERSION}_${crocAsset}.tar.gz`, crocSha);
  const croc = untar(crocTar, "croc", join(work, "croc"));

  // 4. SEA config and blob.
  const [addonTarget, addonSha] = ADDONS[target];
  const addonTar = await fetchPinned(`https://registry.npmjs.org/@node-datachannel/${addonTarget}/-/${addonTarget}-0.33.6.tgz`, addonSha);
  const addon = untar(addonTar, "package/node_datachannel.node", join(work, "addons"));
  const assets = { croc, "addons/node_datachannel.node": addon };
  for (const f of webFiles) assets[`web/${relative(webDir, f).split("\\").join("/")}`] = f;
  const buildId = sha256(Buffer.concat([readFileSync(bundle), ...Object.entries(assets).sort().map(([k, f]) => Buffer.concat([Buffer.from(k), readFileSync(f)]))])).slice(0, 16);
  const manifest = join(work, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ version: `${version}+${commit}`, build: buildId, files: Object.keys(assets).filter((k) => k.startsWith("web/")), croc: "croc", addons: { "node-datachannel": "addons/node_datachannel.node" } }));
  assets["manifest.json"] = manifest;
  const blob = join(work, "sea.blob");
  const config = join(work, "sea-config.json");
  // No snapshot or code cache: both are tied to the CPU/OS that builds them, and we cross-build.
  writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }));
  execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });

  // 5. Official Node for the target, with the blob injected.
  const nodeTar = await fetchPinned(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${target}.tar.gz`, NODE_SHA256[target]);
  const node = untar(nodeTar, `node-v${NODE_VERSION}-${target}/bin/node`, join(work, "node"));
  rmSync(exe, { force: true });
  copyFileSync(node, exe);
  chmodSync(exe, 0o755);
  if (os === "darwin" && process.platform === "darwin") execFileSync("codesign", ["--remove-signature", exe]);
  postject ??= (await import("postject")).inject;
  await postject(exe, "NODE_SEA_BLOB", readFileSync(blob), { sentinelFuse: SEA_FUSE, ...(os === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}) });
  if (os === "darwin") {
    const signer = process.platform === "darwin" ? ["codesign", ["--sign", "-", exe]] : ["rcodesign", ["sign", exe]];
    try {
      execFileSync(signer[0], signer[1], { stdio: "inherit" });
      log(`${target}: ad-hoc signed with ${signer[0]}`);
    } catch {
      log(`${target}: NOT SIGNED (no ${signer[0]}); macOS will refuse to run it until it is signed, e.g. \`codesign --sign - ${relative(root, exe)}\` on a Mac`);
    }
  }
  const digest = sha256(readFileSync(exe));
  writeFileSync(`${exe}.sha256`, `${digest}  spencer-${target}\n`);
  log(`${relative(root, exe)}: ${(statSync(exe).size / 1048576).toFixed(0)} MiB, sha256 ${digest.slice(0, 16)}…`);
}
