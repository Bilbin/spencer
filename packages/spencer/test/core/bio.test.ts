import WebSocket from "ws";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readBio, writeBio } from "../../src/bio.ts";
import { RelayPool } from "../../src/net/relay-client.ts";
import { ChannelManager } from "../../src/channels.ts";
import { Sql, openDb } from "../../src/store/db.ts";
import { generateIdentity, parseBody } from "@spencer/protocol";
import { defaultConfig } from "../../src/config.ts";
import type { DaemonEvent } from "../../src/contracts.ts";
import { http, relayAt, startNode, tempDir, waitFor } from "./helpers.ts";

test("BIO storage is private, trimmed, atomic, UTF-16 bounded and removable", () => {
  const t = tempDir();
  try {
    writeBio(t.dir, "  😀".repeat(1).trim() + "  ");
    assert.equal(readBio(t.dir), "😀");
    assert.equal(statSync(join(t.dir, "BIO.md")).mode & 0o777, 0o600);
    writeBio(t.dir, "😀".repeat(1000));
    assert.throws(() => writeBio(t.dir, "😀".repeat(1001)), /2000/);
    assert.equal(readFileSync(join(t.dir, "BIO.md"), "utf8").length, 2000);
    assert.throws(() => writeBio(t.dir, 42), /string/);
    writeBio(t.dir, " \n ");
    assert.equal(existsSync(join(t.dir, "BIO.md")), false);
    assert.equal(readBio(t.dir), "");
    // B1: hand-edited >2000-char BIO.md is capped safely and parses cleanly; non-ENOENT errors return "".
    writeFileSync(join(t.dir, "BIO.md"), "a".repeat(2500), "utf8");
    const capped = readBio(t.dir);
    assert.equal(capped.length, 2000);
    assert.ok(parseBody({ type: "hello", name: "Alice", agent: "spencer/0.1", about: capped }));
    writeBio(t.dir, "");
    mkdirSync(join(t.dir, "BIO.md"));
    assert.equal(readBio(t.dir), "");
  } finally { t.cleanup(); }
});

test("BIO HTTP discovery, hello clearing, silent updates and WS event payloads", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const A = await startNode(join(t.dir, "a"), relay.url, "Alice");
  const B = await startNode(join(t.dir, "b"), relay.url, "Bob");
  const C = await startNode(join(t.dir, "c"), relay.url, "Carol");
  const sockets = [A, B].map(n => new WebSocket(`ws://127.0.0.1:${n.daemon.port}/api/events?token=${n.daemon.token}`));
  const frames: string[] = [];
  for (const ws of sockets) ws.on("message", data => frames.push(data.toString()));
  await Promise.all(sockets.map(ws => new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); })));
  const events: DaemonEvent[] = [];
  B.daemon.events.subscribe(e => events.push(e));
  const H = { "X-Spencer-Token": A.daemon.token };
  try {
    assert.equal((await http(A.daemon.port, "PUT", "/api/bio", { headers: H, body: { text: "I help with code" } })).status, 200);
    const inv = await A.daemon.createInvite("group", "Team");
    const ch = inv.channel.id;
    await B.daemon.acceptInvite(inv.link);
    await waitFor(() => B.daemon.core.peerBios(ch)[0]?.about === "I help with code");
    const at = B.daemon.core.peerBios(ch)[0].aboutAt!;
    assert.ok(at > 0);
    const helloCount = B.daemon.core.db.prepare("SELECT count(*) AS n FROM messages WHERE type = 'hello' AND COALESCE(origin, '') != 'feature-hello'").get()!.n;
    await A.daemon.core.setBio("Code and research");
    await waitFor(() => B.daemon.core.peerBios(ch)[0]?.about === "Code and research");
    assert.equal(B.daemon.core.db.prepare("SELECT count(*) AS n FROM messages WHERE type = 'hello' AND COALESCE(origin, '') != 'feature-hello'").get()!.n, helloCount);
    assert.ok(events.some(e => e.type === "peer_bio" && e.about === "Code and research"));
    assert.ok(!("about" in B.daemon.core.getChannel(ch)!.members[0]));
    const peers = await http(B.daemon.port, "GET", "/api/peers", { headers: { "X-Spencer-Token": B.daemon.token } });
    assert.equal(peers.status, 200);
    assert.equal(peers.json().peers[0].about, "Code and research");
    assert.equal(peers.json().peers[0].channels[0].id, ch);
    await C.daemon.acceptInvite(inv.link);
    await waitFor(() => C.daemon.core.peerBios(ch).find(p => p.id === A.daemon.identity.id)?.about === "Code and research");
    assert.equal(B.daemon.core.peerBios(ch).find(p => p.id === A.daemon.identity.id)?.about, "Code and research");
    A.daemon.core.db.prepare("UPDATE channels SET last_hello_features = ? WHERE id = ?").run('["old-feature"]', ch);
    A.daemon.channels.recheckHellos();
    const hash = A.daemon.core.db.prepare("SELECT last_hello_about AS hash FROM channels WHERE id = ?").get(ch)!.hash;
    assert.equal(typeof hash, "string");
    assert.equal(A.daemon.channels.buildHello(ch).about, "Code and research");
    const patch = await http(A.daemon.port, "PATCH", `/api/channels/${ch}`, { headers: H, body: { shareBio: false } });
    assert.equal(patch.json().shareBio, false);
    await waitFor(() => B.daemon.core.peerBios(ch).find(p => p.id === A.daemon.identity.id)?.about === null);
    await waitFor(() => frames.some(f => f.includes('"type":"bio"')) && frames.some(f => f.includes('"type":"peer_bio"') && f.includes('"about":null')));
    assert.deepEqual(A.daemon.core.bio().sharedChannels, []);
    assert.equal((await http(A.daemon.port, "PATCH", `/api/channels/${ch}`, { headers: H, body: { shareBio: "false" } })).status, 400);
  } finally { sockets.forEach(ws => ws.terminate()); await C.daemon.stop(); await A.daemon.stop(); await B.daemon.stop(); await relay.close(); t.cleanup(); }
});

test("single hello builder preserves BIO; peer updates are channel-local and throttled with trailing flush", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const tmp = tempDir();
  const db = openDb(tmp.dir);
  const sql = new Sql(db);
  const me = generateIdentity();
  const peer = generateIdentity();
  let changes = 0;
  const pool = new RelayPool(me, { onReady() {}, onDown() {}, onFrame() {} }, () => {}, { wakeCheckMs: 0 });
  const manager = new ChannelManager({ sql, me, config: defaultConfig, pool: () => pool, outbox: () => { throw Error("unused"); }, events: { emit() {} }, log() {}, channelChanged() { changes++; }, bioText: () => "Published", localFeatures: () => ["files"] });
  try {
    for (const ch of ["a", "b"]) sql.run("INSERT INTO channels(id,kind,meta_name,created_by,relay_url,secret,created_at) VALUES (?,'group','Team',?,'ws://localhost','secret',0)", ch, me.id);
    assert.equal(manager.buildHello("a").about, "Published");
    assert.deepEqual(manager.buildHello("a").features, ["files"]);
    sql.run("UPDATE channels SET share_bio = 0 WHERE id = 'a'");
    assert.ok(!("about" in manager.buildHello("a")));
    assert.equal(manager.onHello("a", peer.id, { type: "hello", name: "Bob", agent: "test", about: "First" }).featureOnly, false);
    for (let i = 0; i < 50; i++) assert.equal(manager.onHello("a", peer.id, { type: "hello", name: "Bob", agent: "test", about: `Bio ${i}` }).featureOnly, true);
    assert.equal(changes, 1);
    assert.equal(manager.peerBios("a")[0].about, "Bio 49");
    assert.deepEqual(manager.peerBios("b"), []);
    t.mock.timers.tick(120_000);
    assert.equal(changes, 2);
    // M1: rename + bio change in one hello is NOT throttled.
    manager.onHello("a", peer.id, { type: "hello", name: "Bob", agent: "test", about: "Rapid 1" });
    const beforeRename = changes;
    manager.onHello("a", peer.id, { type: "hello", name: "Robert", agent: "test", about: "Rapid 2" });
    assert.equal(changes, beforeRename + 1);
    // M2: clearing bio in channel b does NOT hide a shared bio in channel a.
    t.mock.timers.tick(1000);
    manager.onHello("b", peer.id, { type: "hello", name: "Robert", agent: "test", about: "Newest" });
    let directory = manager.listPeerDirectory();
    assert.equal(directory.length, 1);
    assert.equal(directory[0].about, "Newest");
    assert.equal(directory[0].channels.length, 2);
    t.mock.timers.tick(1000);
    manager.onHello("b", peer.id, { type: "hello", name: "Robert", agent: "test" });
    directory = manager.listPeerDirectory();
    assert.equal(directory[0].about, "Rapid 2");
    // M8: initial hello with no bio does not stamp aboutAt.
    const fresh = generateIdentity();
    manager.onHello("b", fresh.id, { type: "hello", name: "NoBio", agent: "test" });
    assert.equal(manager.peerBios("b").find(p => p.id === fresh.id)?.aboutAt, null);
  } finally { manager.stop(); db.close(); tmp.cleanup(); }
});
