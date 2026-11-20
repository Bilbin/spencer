#!/usr/bin/env node
// Cross-machine end-to-end check between two running Spencers, driven only through their local HTTP APIs
// (exactly what the web UI does). Spencer A is local; B is usually reached through an SSH tunnel.
//
//   A_URL=http://127.0.0.1:7430 A_TOKEN=… B_URL=http://127.0.0.1:7431 B_TOKEN=… \
//   A_FILE=/abs/local/file B_FILE=/abs/file/on/B  node scripts/e2e-two-hosts.mjs
//
// Optional: B_SHA_CMD — a shell command that prints "sha256  path" lines for a path on B ("{}" is replaced),
// e.g. "ssh user@host sha256sum {}", used to verify the file that landed in B's quarantine.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const A = { name: "A", url: env("A_URL"), token: env("A_TOKEN") };
const B = { name: "B", url: env("B_URL"), token: env("B_TOKEN") };
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);

async function api(s, method, path, body) {
  const r = await fetch(s.url + path, {
    method,
    headers: { "X-Spencer-Token": s.token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${s.name} ${method} ${path} → ${r.status} ${text}`);
  return text ? JSON.parse(text) : {};
}
async function until(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const msgs = async (s, ch) => (await api(s, "GET", `/api/channels/${ch}/messages?limit=100`)).items;
const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const stA = await api(A, "GET", "/api/state");
const stB = await api(B, "GET", "/api/state");
log(`A = ${stA.me.name} (${stA.me.fingerprint})   B = ${stB.me.name} (${stB.me.fingerprint})`);

// 1. Pair: A invites, B joins.
const { link, channel } = await api(A, "POST", "/api/invites", { kind: "direct", name: stB.me.name });
const ch = channel.id;
log(`A created direct invite ${link.replace(/#.*/, "#<secret>")}`);
await api(B, "POST", "/api/invites/accept", { link });
log("B accepted the invite");
await until("hellos on both sides", async () => {
  const [a, b] = [await api(A, "GET", "/api/state"), await api(B, "GET", "/api/state")];
  const ca = a.channels.find((c) => c.id === ch);
  const cb = b.channels.find((c) => c.id === ch);
  return ca?.members.some((m) => !m.me && m.name === stB.me.name) && cb?.members.some((m) => !m.me && m.name === stA.me.name);
});
log("hellos exchanged: both sides know each other's name");

// 2. Messages both ways (human → peer agent auto-reply).
for (const [from, to, text] of [
  [A, B, `hello from ${stA.me.name} at ${new Date().toISOString()}`],
  [B, A, `hello back from ${stB.me.name} at ${new Date().toISOString()}`],
]) {
  const { id } = await api(from, "POST", `/api/channels/${ch}/messages`, { text });
  await until(`${to.name} receives ${from.name}'s message`, async () => (await msgs(to, ch)).some((m) => m.id === id));
  log(`${from.name} → ${to.name}: delivered "${text}"`);
  const reply = await until(`${to.name}'s agent reply`, async () =>
    (await msgs(from, ch)).find((m) => m.replyTo === id && !m.mine && m.by === "agent"),
  );
  log(`${to.name}'s agent → ${from.name}: "${reply.text}" (hop ${reply.hop})`);
}

// 3. Files both ways via croc.
async function sendFile(from, to, path, localSha) {
  let t = await api(from, "POST", "/api/transfers", { ch, path });
  log(`${from.name} requested ${path} → state ${t.state}`);
  if (t.state === "awaiting_approval") t = await api(from, "POST", `/api/transfers/${t.tid}/approve`);
  log(`${from.name} approved → ${t.state}`);
  const done = await until(
    `transfer ${t.tid} completes on both sides`,
    async () => {
      const x = await api(from, "GET", `/api/transfers/${t.tid}`);
      // The recipient only knows the transfer once the offer has crossed the relay.
      const y = await api(to, "GET", `/api/transfers/${t.tid}`).catch((e) => {
        if (/ 404 /.test(e.message)) return { state: "not yet offered" };
        throw e;
      });
      if ([x.state, y.state].some((s) => ["failed", "expired", "cancelled", "declined", "denied"].includes(s)))
        throw new Error(`transfer ended ${x.state}/${y.state}: ${x.error ?? ""} ${y.error ?? ""}`);
      return x.state === "completed" && y.state === "completed" ? { x, y } : null;
    },
    180_000,
  );
  log(`${from.name} → ${to.name}: completed, ${done.y.size} bytes, attempt ${done.y.attempt}, quarantined at ${done.y.path}`);
  if (done.y.sha256 !== done.x.sha256) throw new Error("sha256 differs between sides");
  return done;
}

const aSha = sha256File(env("A_FILE"));
const ab = await sendFile(A, B, env("A_FILE"));
if (process.env.B_SHA_CMD) {
  const out = execSync(process.env.B_SHA_CMD.replace("{}", JSON.stringify(ab.y.path)), { encoding: "utf8" });
  if (!out.startsWith(aSha)) throw new Error(`B's quarantined file hash mismatch: ${out}`);
  log(`verified on B's disk: sha256 ${aSha.slice(0, 16)}… matches A's original`);
}
const ba = await sendFile(B, A, env("B_FILE"));
const got = sha256File(ba.y.path);
if (got !== ba.x.sha256) throw new Error("A's quarantined file hash mismatch");
log(`verified on A's disk: sha256 ${got.slice(0, 16)}… matches B's original`);

log(`ALL GOOD — channel ${ch}`);
