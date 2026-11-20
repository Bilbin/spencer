import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import {
  deriveChannelKeys,
  generateIdentity,
  joinProof,
  newChannelSecret,
  relayAuthMessage,
  sealEnvelope,
  sealMeta,
  signText,
  type ChannelKeys,
  type Envelope,
  type Identity,
} from "@spencer/protocol";
import { startRelay } from "../src/index.ts";

type Frame = Record<string, any>;

const tmp = mkdtempSync(join(tmpdir(), "spencer-relay-test-"));
let dbCounter = 0;
const relays: { close(): Promise<void> }[] = [];
const clients: Client[] = [];

after(async () => {
  for (const c of clients) c.close();
  for (const r of relays) await r.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function relay(extra: Partial<Parameters<typeof startRelay>[0]> = {}) {
  const dbPath = join(tmp, `relay-${++dbCounter}.sqlite`);
  const r = await startRelay({ port: 0, dbPath, ...extra });
  relays.push(r);
  return { ...r, dbPath };
}

class Client {
  ws: WebSocket;
  frames: Frame[] = [];
  waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  closed: Promise<number>;
  nonce = "";
  identity: Identity;
  welcome: Frame | null = null;
  private ridN = 0;

  constructor(url: string, identity: Identity) {
    this.identity = identity;
    this.ws = new WebSocket(url);
    clients.push(this);
    this.closed = new Promise((resolve) => this.ws.on("close", (code) => resolve(code)));
    this.ws.on("message", (data) => {
      const f = JSON.parse(String(data)) as Frame;
      const i = this.waiters.findIndex((w) => w.pred(f));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(f);
      else this.frames.push(f);
    });
  }

  static async connect(url: string, identity = generateIdentity(), auth = true): Promise<Client> {
    const c = new Client(url, identity);
    const ch = await c.next((f) => f.t === "challenge");
    c.nonce = ch.nonce;
    if (auth) {
      c.raw({ t: "auth", id: identity.id, sig: signText(identity.secret, relayAuthMessage(c.nonce)) });
      c.welcome = await c.next((f) => f.t === "welcome" || f.t === "err");
      assert.equal(c.welcome.t, "welcome");
    }
    return c;
  }

  get id() {
    return this.identity.id;
  }

  raw(f: unknown) {
    this.ws.send(typeof f === "string" ? f : JSON.stringify(f));
  }

  next(pred: (f: Frame) => boolean = () => true, ms = 3000): Promise<Frame> {
    const i = this.frames.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.frames.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve: (f: Frame) => {
          clearTimeout(timer);
          resolve(f);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error("timeout waiting for frame"));
      }, ms);
      this.waiters.push(w);
    });
  }

  /** Sends a request and resolves with its ok/err reply. */
  req(f: Frame): Promise<Frame> {
    const rid = `r${++this.ridN}`;
    this.raw({ ...f, rid });
    return this.next((x) => x.rid === rid && (x.t === "ok" || x.t === "err"));
  }

  /** Frames already received and not consumed, matching pred (consumed by this call). */
  take(pred: (f: Frame) => boolean): Frame[] {
    const out = this.frames.filter(pred);
    this.frames = this.frames.filter((f) => !pred(f));
    return out;
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
  }
}

interface Chan {
  ch: string;
  secret: string;
  keys: ChannelKeys;
}

async function create(c: Client, kind: "direct" | "group" = "direct", maxMembers = kind === "direct" ? 2 : 32) {
  const { ch, secret } = newChannelSecret();
  const keys = deriveChannelKeys(secret, ch);
  const meta = sealMeta(keys, ch, { name: "test", kind, createdBy: c.id });
  const reply = await c.req({
    t: "create",
    ch,
    kind,
    maxMembers,
    capPub: keys.capPub,
    meta,
    proof: joinProof(keys, ch, c.id, c.nonce),
  });
  assert.equal(reply.t, "ok", JSON.stringify(reply));
  return { chan: { ch, secret, keys } as Chan, reply };
}

const join_ = (c: Client, chan: Chan) => c.req({ t: "join", ch: chan.ch, proof: joinProof(chan.keys, chan.ch, c.id, c.nonce) });

const env = (c: Client, chan: Chan, text = "hi") =>
  sealEnvelope(c.identity, chan.ch, chan.keys.encKey, { type: "chat", text, hop: 0, by: "human" });

const send = (c: Client, e: Envelope) => c.req({ t: "send", env: e });

/** Round-trips a ping so every earlier frame on this connection has been processed. */
const sync = async (c: Client) => assert.equal((await c.req({ t: "ping" })).t, "ok");

function countMessages(dbPath: string, ch: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE ch = ?").get(ch) as { n: number }).n;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------

let shared: Awaited<ReturnType<typeof relay>>;
before(async () => {
  shared = await relay();
});

test("auth: good signature gets welcome; bad signature is rejected and closed", async () => {
  const good = await Client.connect(shared.url);
  assert.equal(good.welcome!.id, good.id);
  assert.equal(good.welcome!.croc, undefined);

  const id = generateIdentity();
  const bad = await Client.connect(shared.url, id, false);
  bad.raw({ t: "auth", id: id.id, sig: signText(id.secret, relayAuthMessage("wrong-nonce")) });
  const e = await bad.next();
  assert.equal(e.t, "err");
  assert.equal(e.code, "bad_sig");
  assert.equal(await bad.closed, 1008);

  // signature by a different key
  const other = generateIdentity();
  const bad2 = await Client.connect(shared.url, id, false);
  bad2.raw({ t: "auth", id: id.id, sig: signText(other.secret, relayAuthMessage(bad2.nonce)) });
  assert.equal((await bad2.next()).code, "bad_sig");
});

test("auth: frames before auth get unauthenticated", async () => {
  const c = await Client.connect(shared.url, generateIdentity(), false);
  const r = await c.req({ t: "ping" });
  assert.equal(r.t, "err");
  assert.equal(r.code, "unauthenticated");
  const r2 = await c.req({ t: "join", ch: "x", proof: "y" });
  assert.equal(r2.code, "unauthenticated");
  c.raw("not json");
  assert.equal((await c.next()).code, "bad_request");
});

test("create + join; direct channel refuses a third member; bad proof", async () => {
  const a = await Client.connect(shared.url);
  const b = await Client.connect(shared.url);
  const c = await Client.connect(shared.url);
  const { chan, reply } = await create(a);
  assert.equal(reply.head, 0);
  assert.deepEqual(
    reply.members.map((m: Frame) => m.id),
    [a.id],
  );

  // idempotent create
  const again = await a.req({
    t: "create",
    ch: chan.ch,
    kind: "direct",
    maxMembers: 2,
    capPub: chan.keys.capPub,
    meta: sealMeta(chan.keys, chan.ch, { name: "test", kind: "direct", createdBy: a.id }),
    proof: joinProof(chan.keys, chan.ch, a.id, a.nonce),
  });
  assert.equal(again.t, "ok");

  // bad proof: signed for a different connection nonce
  const badProof = await b.req({ t: "join", ch: chan.ch, proof: joinProof(chan.keys, chan.ch, b.id, a.nonce) });
  assert.equal(badProof.code, "bad_proof");
  // bad proof: wrong capability key
  const wrongKeys = deriveChannelKeys(newChannelSecret().secret, chan.ch);
  assert.equal((await b.req({ t: "join", ch: chan.ch, proof: joinProof(wrongKeys, chan.ch, b.id, b.nonce) })).code, "bad_proof");

  const j = await join_(b, chan);
  assert.equal(j.t, "ok");
  assert.equal(j.kind, "direct");
  assert.equal(j.maxMembers, 2);
  assert.equal(typeof j.meta, "string");
  assert.equal(j.members.length, 2);

  // joining again just replies
  assert.equal((await join_(b, chan)).t, "ok");

  const full = await join_(c, chan);
  assert.equal(full.t, "err");
  assert.equal(full.code, "full");

  // no such channel
  assert.equal((await c.req({ t: "join", ch: newChannelSecret().ch, proof: "x" })).code, "no_channel");

  const members = await a.req({ t: "members", ch: chan.ch });
  assert.deepEqual(members.members.map((m: Frame) => m.id).sort(), [a.id, b.id].sort());
  assert.equal(typeof members.members[0].joinedAt, "number");
  assert.equal((await c.req({ t: "members", ch: chan.ch })).code, "not_member");
});

test("member joined/left events reach online members", async () => {
  const a = await Client.connect(shared.url);
  const b = await Client.connect(shared.url);
  const { chan } = await create(a, "group");
  await join_(b, chan);
  const ev = await a.next((f) => f.t === "member");
  assert.deepEqual(ev, { t: "member", ch: chan.ch, id: b.id, event: "joined" });
  assert.equal((await b.req({ t: "leave", ch: chan.ch })).t, "ok");
  const left = await a.next((f) => f.t === "member");
  assert.deepEqual(left, { t: "member", ch: chan.ch, id: b.id, event: "left" });
  assert.equal(b.take((f) => f.t === "member").length, 0);
});

test("send: seq, dedupe on env.id, fan-out to others but not the sender", async () => {
  const a = await Client.connect(shared.url);
  const b = await Client.connect(shared.url);
  const { chan } = await create(a);
  await join_(b, chan);
  assert.equal((await a.req({ t: "sub", ch: chan.ch, since: 0 })).t, "ok");
  assert.equal((await b.req({ t: "sub", ch: chan.ch, since: 0 })).t, "ok");

  const e1 = env(a, chan, "one");
  const r1 = await send(a, e1);
  assert.deepEqual(r1, { t: "ok", rid: r1.rid, id: e1.id, seq: 1 });
  const m1 = await b.next((f) => f.t === "msg");
  assert.equal(m1.seq, 1);
  assert.equal(m1.ch, chan.ch);
  assert.deepEqual(m1.env, e1);

  // resend of the identical envelope: same seq, no second delivery
  const r1b = await send(a, e1);
  assert.equal(r1b.seq, 1);
  const r2 = await send(a, env(a, chan, "two"));
  assert.equal(r2.seq, 2);
  const m2 = await b.next((f) => f.t === "msg");
  assert.equal(m2.seq, 2);
  await sync(b);
  assert.equal(b.take((f) => f.t === "msg").length, 0);
  await sync(a);
  assert.equal(a.take((f) => f.t === "msg").length, 0, "sender gets no echo");
});

test("send: forged and invalid envelopes are rejected; non-members can't send or sub", async () => {
  const a = await Client.connect(shared.url);
  const b = await Client.connect(shared.url);
  const outsider = await Client.connect(shared.url);
  const { chan } = await create(a);
  await join_(b, chan);

  // from != connection identity (b signs as itself, a sends it)
  const forged = await send(a, env(b, chan));
  assert.equal(forged.t, "err");
  assert.equal(forged.code, "bad_sig");

  // tampered ciphertext → bad signature
  const e = env(a, chan);
  const tampered = { ...e, ct: e.ct.slice(0, -2) + (e.ct.endsWith("AA") ? "BB" : "AA") };
  assert.equal((await send(a, tampered)).code, "bad_sig");

  // malformed
  assert.equal((await send(a, { ...e, v: 2 } as any)).code, "bad_request");

  // too large (still structurally valid; size checked before signature)
  const big = { ...e, ct: "A".repeat(70 * 1024) };
  assert.equal((await send(a, big)).code, "too_large");

  // outsider
  const oe = sealEnvelope(outsider.identity, chan.ch, chan.keys.encKey, { type: "chat", text: "x", hop: 0, by: "human" });
  assert.equal((await send(outsider, oe)).code, "not_member");
  assert.equal((await outsider.req({ t: "sub", ch: chan.ch, since: 0 })).code, "not_member");
  assert.equal((await outsider.req({ t: "leave", ch: chan.ch })).code, "not_member");
});

test("sub: catch-up after being offline, ordered, excluding own messages, then live", async () => {
  const a = await Client.connect(shared.url);
  const bId = generateIdentity();
  let b = await Client.connect(shared.url, bId);
  const { chan } = await create(a, "group");
  await join_(b, chan);
  b.close();

  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const e = env(a, chan, `m${i}`);
    ids.push(e.id);
    assert.equal((await send(a, e)).seq, i + 1);
  }

  b = await Client.connect(shared.url, bId);
  // b's own message must not come back in its backlog
  assert.equal((await send(b, env(b, chan, "mine"))).seq, 6);
  assert.equal((await send(a, env(a, chan, "m5"))).seq, 7);

  const sub = b.req({ t: "sub", ch: chan.ch, since: 2 });
  const reply = await sub;
  assert.equal(reply.t, "ok");
  assert.equal(reply.head, 7);
  assert.equal(reply.first, 1);
  assert.equal(reply.members.length, 2);
  const msgs = b.take((f) => f.t === "msg");
  assert.deepEqual(
    msgs.map((m) => m.seq),
    [3, 4, 5, 7],
  );
  assert.deepEqual(
    msgs.slice(0, 3).map((m) => m.env.id),
    ids.slice(2),
  );

  // live now
  await send(a, env(a, chan, "live"));
  assert.equal((await b.next((f) => f.t === "msg")).seq, 8);
});

test("ack: message deleted once every member acked; the sender counts as acked", async () => {
  const r = await relay();
  const a = await Client.connect(r.url);
  const b = await Client.connect(r.url);
  const c = await Client.connect(r.url);
  const { chan } = await create(a, "group");
  await join_(b, chan);
  await join_(c, chan);
  await send(a, env(a, chan, "1"));
  await send(a, env(a, chan, "2"));
  assert.equal(countMessages(r.dbPath, chan.ch), 2);

  b.raw({ t: "ack", ch: chan.ch, seq: 2 });
  await sync(b);
  assert.equal(countMessages(r.dbPath, chan.ch), 2, "c has not acked yet");
  c.raw({ t: "ack", ch: chan.ch, seq: 1 });
  await sync(c);
  assert.equal(countMessages(r.dbPath, chan.ch), 1);
  // ack beyond head is clamped and does not pre-ack future messages
  c.raw({ t: "ack", ch: chan.ch, seq: 1000 });
  await sync(c);
  assert.equal(countMessages(r.dbPath, chan.ch), 0);
  await send(a, env(a, chan, "3"));
  assert.equal(countMessages(r.dbPath, chan.ch), 1);

  // a member leaving unblocks GC
  b.raw({ t: "ack", ch: chan.ch, seq: 3 });
  await sync(b);
  assert.equal(countMessages(r.dbPath, chan.ch), 1);
  await c.req({ t: "leave", ch: chan.ch });
  assert.equal(countMessages(r.dbPath, chan.ch), 0);
});

test("TTL: messages older than ttl expire; sub reports the gap via first", async () => {
  let t = Date.UTC(2026, 0, 1);
  const r = await relay({ now: () => t, ttlDays: 14 });
  const a = await Client.connect(r.url);
  const b = await Client.connect(r.url);
  const { chan } = await create(a);
  await join_(b, chan);
  await send(a, env(a, chan, "old1"));
  await send(a, env(a, chan, "old2"));
  t += 13 * 86_400_000;
  await send(a, env(a, chan, "newer"));
  t += 2 * 86_400_000; // old1/old2 are now 15 days old, "newer" is 2 days old
  const reply = await b.req({ t: "sub", ch: chan.ch, since: 0 });
  assert.equal(reply.head, 3);
  assert.equal(reply.first, 3);
  assert.deepEqual(
    b.take((f) => f.t === "msg").map((m) => m.seq),
    [3],
  );
  assert.equal(countMessages(r.dbPath, chan.ch), 1);
  // a client that already had everything up to 2 sees no gap
  const r2 = await b.req({ t: "sub", ch: chan.ch, since: 2 });
  assert.ok(r2.first <= 3);
});

test("croc info only after membership", async () => {
  const r = await relay({ crocRelay: "relay.example:9009", crocPass: "pw" });
  const id = generateIdentity();
  const a = await Client.connect(r.url, id);
  assert.equal(a.welcome!.croc, undefined);
  const { reply } = await create(a);
  assert.deepEqual(reply.croc, { relay: "relay.example:9009", pass: "pw" });
  a.close();
  const again = await Client.connect(r.url, id);
  assert.deepEqual(again.welcome!.croc, { relay: "relay.example:9009", pass: "pw" });
});

test("rate limiting: a burst beyond 30 sends gets rate_limited", async () => {
  const r = await relay();
  const a = await Client.connect(r.url);
  const { chan } = await create(a);
  const replies = await Promise.all(Array.from({ length: 40 }, () => send(a, env(a, chan))));
  const okN = replies.filter((x) => x.t === "ok").length;
  const limited = replies.filter((x) => x.code === "rate_limited").length;
  assert.ok(okN >= 30 && okN < 40, `ok=${okN}`);
  assert.equal(okN + limited, 40);
});

test("limits: unknown frames, bad rid, bad create params", async () => {
  const a = await Client.connect(shared.url);
  assert.equal((await a.req({ t: "nope" })).code, "bad_request");
  a.raw({ t: "ping" });
  assert.equal((await a.next()).code, "bad_request");
  const { ch, secret } = newChannelSecret();
  const keys = deriveChannelKeys(secret, ch);
  const r = await a.req({
    t: "create",
    ch,
    kind: "direct",
    maxMembers: 5,
    capPub: keys.capPub,
    meta: "abc",
    proof: joinProof(keys, ch, a.id, a.nonce),
  });
  assert.equal(r.code, "bad_request");
});

test("http: healthz, invite page, 404", async () => {
  const h = await fetch(`${shared.httpUrl}/healthz`);
  assert.equal(h.status, 200);
  assert.equal(await h.text(), "ok");

  const { ch } = newChannelSecret();
  const p = await fetch(`${shared.httpUrl}/i/${ch}`);
  assert.equal(p.status, 200);
  const csp = p.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'sha256-/);
  assert.equal(p.headers.get("referrer-policy"), "no-referrer");
  const html = await p.text();
  assert.match(html, /This is a Spencer invite/);
  assert.match(html, /location\.href/);
  assert.doesNotMatch(html, /fetch\(|XMLHttpRequest|sendBeacon/);

  assert.equal((await fetch(`${shared.httpUrl}/i/short`)).status, 404);
  assert.equal((await fetch(`${shared.httpUrl}/nope`)).status, 404);

  // websocket upgrade on another path is refused
  const ws = new WebSocket(`${shared.httpUrl.replace("http", "ws")}/other`);
  await new Promise<void>((resolve) => {
    ws.on("error", () => resolve());
    ws.on("unexpected-response", () => {
      ws.terminate();
      resolve();
    });
  });
});

test("sub: large backlog streams across pages in order (backpressure path)", async () => {
  const r = await relay();
  const aId = generateIdentity();
  const a = await Client.connect(r.url, aId);
  const b = await Client.connect(r.url);
  const { chan } = await create(a, "group");
  await join_(b, chan);
  // The send bucket is per connection, so spread the sends over several connections of `a`.
  const senders = [a, ...(await Promise.all(Array.from({ length: 7 }, () => Client.connect(r.url, aId))))];
  const text = "x".repeat(15_000);
  for (const s of senders) {
    const replies = await Promise.all(Array.from({ length: 30 }, () => send(s, env(s, chan, text))));
    assert.ok(replies.every((x) => x.t === "ok"));
  }
  const reply = await b.req({ t: "sub", ch: chan.ch, since: 0 });
  assert.equal(reply.head, 240);
  const seqs = b.take((f) => f.t === "msg").map((m) => m.seq);
  assert.deepEqual(
    seqs,
    Array.from({ length: 240 }, (_, i) => i + 1),
  );
  for (const s of senders) s.close();
});

test("presence: welcome lists features; members carry online/lastSeen; co-members get presence frames", async () => {
  let t = 1_000_000;
  const r = await relay({ now: () => t });
  const a = await Client.connect(r.url);
  assert.deepEqual(a.welcome!.features, ["presence", "ephemeral"]);
  const { chan } = await create(a);
  const b = await Client.connect(r.url);
  const joined = await join_(b, chan);
  const byId = (list: Frame[]) => Object.fromEntries(list.map((m) => [m.id, m]));
  assert.equal(byId(joined.members)[a.id].online, true);
  assert.equal(byId(joined.members)[a.id].lastSeen, 1_000_000);
  await sync(a);
  a.take(() => true);

  // b disconnects: a hears it, with the time.
  t = 2_000_000;
  b.close();
  const off = await a.next((f) => f.t === "presence");
  assert.deepEqual(off, { t: "presence", ch: chan.ch, id: b.id, online: false, lastSeen: 2_000_000 });
  const sub = await a.req({ t: "sub", ch: chan.ch, since: 0 });
  assert.equal(byId(sub.members)[b.id].online, false);
  assert.equal(byId(sub.members)[b.id].lastSeen, 2_000_000);
  const members = await a.req({ t: "members", ch: chan.ch });
  assert.equal(byId(members.members)[a.id].online, true);

  // b comes back; a second connection of b's does not announce again, and closing one of two does not go offline.
  t = 3_000_000;
  const b2 = await Client.connect(r.url, b.identity);
  assert.deepEqual(await a.next((f) => f.t === "presence"), { t: "presence", ch: chan.ch, id: b.id, online: true, lastSeen: 3_000_000 });
  const b3 = await Client.connect(r.url, b.identity);
  b3.close();
  await b3.closed;
  await sync(a);
  await sync(b2);
  assert.deepEqual(a.take((f) => f.t === "presence"), []);
});

test("ephemeral sends: pushed live as `eph`, never stored or redelivered; an older relay (feature off) just stores them", async () => {
  const r = await relay();
  const a = await Client.connect(r.url);
  const { chan } = await create(a);
  const b = await Client.connect(r.url);
  await join_(b, chan);
  assert.equal((await b.req({ t: "sub", ch: chan.ch, since: 0 })).t, "ok");
  const e = env(a, chan, "working…");
  const ok = await a.req({ t: "send", env: e, ephemeral: true });
  assert.equal(ok.t, "ok");
  assert.equal(ok.id, e.id);
  assert.equal(ok.seq, undefined);
  const got = await b.next((f) => f.t === "eph");
  assert.deepEqual(got, { t: "eph", ch: chan.ch, env: e });
  assert.equal(countMessages(r.dbPath, chan.ch), 0, "not stored");
  // Same checks as a normal send: a forged sender is refused.
  const forged = { ...env(b, chan), from: a.id };
  assert.equal((await b.req({ t: "send", env: forged, ephemeral: true })).code, "bad_sig");

  const old = await relay({ features: { presence: false, ephemeral: false } });
  const oa = await Client.connect(old.url);
  assert.deepEqual(oa.welcome!.features, []);
  const { chan: oc } = await create(oa);
  const ob = await Client.connect(old.url);
  const oj = await join_(ob, oc);
  assert.equal(oj.members[0].online, undefined, "no presence fields");
  const oe = env(oa, oc, "working…");
  const stored = await oa.req({ t: "send", env: oe, ephemeral: true });
  assert.equal(stored.seq, 1, "stored like any message");
  assert.equal(countMessages(old.dbPath, oc.ch), 1);
});
