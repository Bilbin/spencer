import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { http, relayAt, startNode, tempDir, waitFor } from "./helpers.ts";

function wsOpen(url: string, headers: Record<string, string> = {}): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve({ ws }));
    ws.once("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.once("error", () => resolve({ status: -1 }));
  });
}

test("http api: guards, state, owner + channel messages, invites, events ws", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const web = join(t.dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), '<html><head><meta name="spencer-token" content="__SPENCER_TOKEN__"></head></html>');
  writeFileSync(join(web, "app.js"), "console.log(1)");
  writeFileSync(join(t.dir, "secret.txt"), "nope");
  mkdirSync(join(t.dir, "a"));
  mkdirSync(join(t.dir, "b"));
  const A = await startNode(join(t.dir, "a"), relay.url, "Alice", { webRoot: web });
  const B = await startNode(join(t.dir, "b"), relay.url, "Bob");
  const sockets: WebSocket[] = [];
  try {
    const port = A.daemon.port;
    const token = A.daemon.token;
    const H = { "X-Spencer-Token": token };

    // --- guards
    assert.equal((await http(port, "GET", "/api/state", { headers: H, host: `evil.example:${port}` })).status, 403);
    assert.equal((await http(port, "GET", "/", { host: "evil.example" })).status, 403);
    assert.equal((await http(port, "GET", "/api/state")).status, 401);
    assert.equal((await http(port, "GET", "/api/state", { headers: { "X-Spencer-Token": "0".repeat(64) } })).status, 401);
    assert.equal((await http(port, "GET", "/api/state", { headers: H, host: `localhost:${port}` })).status, 200);

    // --- static + token injection + headers + traversal
    const idx = await http(port, "GET", "/");
    assert.equal(idx.status, 200);
    assert.ok(idx.text.includes(`content="${token}"`));
    assert.match(String(idx.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.match(String(idx.headers["content-security-policy"]), new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${port} ws://localhost:${port}`));
    assert.equal(idx.headers["x-content-type-options"], "nosniff");
    assert.equal(idx.headers["referrer-policy"], "no-referrer");
    assert.equal(idx.headers["access-control-allow-origin"], undefined);
    assert.equal((await http(port, "GET", "/app.js")).status, 200);
    assert.notEqual((await http(port, "GET", "/../secret.txt")).status, 200);
    assert.notEqual((await http(port, "GET", "/%2e%2e/secret.txt")).status, 200);
    assert.notEqual((await http(port, "GET", "/..%2fsecret.txt")).status, 200);

    // --- state shape
    const st = (await http(port, "GET", "/api/state", { headers: H })).json();
    assert.deepEqual(Object.keys(st.me).sort(), ["fingerprint", "id", "name"]);
    assert.equal(st.me.name, "Alice");
    assert.equal(st.relay.url, relay.url);
    assert.equal(typeof st.relay.connected, "boolean");
    assert.deepEqual(st.channels, []);
    assert.deepEqual(st.transfers, []);
    assert.deepEqual(st.mcp, []);
    assert.equal(st.policy.maxHops, 40);
    assert.equal(st.policy.maxAgentTurns, 20);

    // --- events ws: origin / token / host checks
    const base = `ws://127.0.0.1:${port}/api/events`;
    assert.equal((await wsOpen(`${base}?token=bad`)).status, 401);
    assert.equal((await wsOpen(`${base}?token=${token}`, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await wsOpen(`${base}?token=${token}`, { Origin: `http://localhost:${port + 1}` })).status, 403);
    assert.equal((await wsOpen(`${base}?token=${token}`, { Host: "evil.example" })).status, 403);
    const ok1 = await wsOpen(`${base}?token=${token}`, { Origin: `http://127.0.0.1:${port}` });
    assert.ok(ok1.ws);
    sockets.push(ok1.ws!);
    const ok2 = await wsOpen(`${base}?token=${token}`); // non-browser client: no Origin
    assert.ok(ok2.ws);
    sockets.push(ok2.ws!);
    const events: any[] = [];
    ok1.ws!.on("message", (d) => events.push(JSON.parse(d.toString())));

    // --- owner message
    const om = await http(port, "POST", "/api/owner/messages", { headers: H, body: { text: "hello spencer" } });
    assert.equal(om.status, 200);
    assert.equal(om.json().submissionId, "sub-1");
    assert.deepEqual(A.agent().ownerSends, ["hello spencer"]);
    assert.equal((await http(port, "POST", "/api/owner/messages", { headers: H, body: { text: "" } })).status, 400);
    assert.equal((await http(port, "POST", "/api/owner/messages", { headers: H, body: "{not json" })).status, 400);
    const tr = (await http(port, "GET", "/api/owner/messages?limit=10", { headers: H })).json();
    assert.equal(tr.items[0].text, "hello spencer");

    // --- invites over HTTP
    const inv = await http(port, "POST", "/api/invites", { headers: H, body: { kind: "direct", name: "Bob" } });
    assert.equal(inv.status, 200);
    const { link, channel } = inv.json();
    assert.equal(channel.name, "Bob");
    assert.equal((await http(port, "POST", "/api/invites", { headers: H, body: { kind: "weird", name: "x" } })).status, 400);
    const acc = await http(B.daemon.port, "POST", "/api/invites/accept", { headers: { "X-Spencer-Token": B.daemon.token }, body: { link } });
    assert.equal(acc.status, 200);
    assert.equal(acc.json().channel.id, channel.id);
    assert.equal(
      (await http(B.daemon.port, "POST", "/api/invites/accept", { headers: { "X-Spencer-Token": B.daemon.token }, body: { link: "nope" } })).status,
      400,
    );
    const ch = channel.id;
    await waitFor(() => A.daemon.core.getChannel(ch)!.members.length === 2, "joined");

    // --- channel message
    const pm = await http(port, "POST", `/api/channels/${ch}/messages`, { headers: H, body: { text: "hi from http" } });
    assert.equal(pm.status, 200);
    const id = pm.json().id;
    const row = A.daemon.db.prepare("SELECT ch, type FROM outbox WHERE id = ?").get(id) as { ch: string; type: string };
    assert.deepEqual({ ...row }, { ch, type: "chat" });
    await waitFor(() => B.agent().peerChats.some((c) => c.id === id && c.body.text === "hi from http"), "B got http message");
    await waitFor(() => events.some((e) => e.type === "message" && e.message.id === id && e.message.status === "sent"), "ws message event");
    assert.ok(events.some((e) => e.type === "message" && e.message.id === id && e.message.status === "pending"));
    assert.ok(events.some((e) => e.type === "channel" && e.channel.id === ch));
    assert.equal((await http(port, "POST", `/api/channels/${ch}/messages`, { headers: H, body: { text: "x".repeat(16_001) } })).status, 400);
    assert.equal((await http(port, "POST", `/api/channels/AAAAAAAAAAAAAAAAAAAAAA/messages`, { headers: H, body: { text: "x" } })).status, 404);

    // incoming on A shows up in the list, unread resets on read
    const back = B.daemon.sendHuman(ch, "back at you");
    await waitFor(() => events.some((e) => e.type === "message" && e.message.id === back.id), "incoming event");
    assert.equal(A.daemon.core.getChannel(ch)!.unread, 1);
    const list = (await http(port, "GET", `/api/channels/${ch}/messages?limit=10`, { headers: H })).json();
    assert.ok(list.items.some((m: any) => m.type === "hello" && !m.mine && m.fromName === "Bob"));
    assert.deepEqual(
      list.items.filter((m: any) => m.type === "chat").map((m: any) => [m.text, m.mine, m.status]),
      [
        ["hi from http", true, "sent"],
        ["back at you", false, "received"],
      ],
    );
    assert.equal(A.daemon.core.getChannel(ch)!.unread, 0);
    const older = (await http(port, "GET", `/api/channels/${ch}/messages?before=${back.id}`, { headers: H })).json();
    assert.deepEqual(
      older.items.filter((m: any) => m.type === "chat").map((m: any) => m.id),
      [id],
    );
    assert.ok(older.items.every((m: any) => m.id !== back.id));

    // --- patch channel
    const pt = await http(port, "PATCH", `/api/channels/${ch}`, { headers: H, body: { name: "Bobby", autoReply: false, allowedMcpTools: ["mcp__fs__read"] } });
    assert.equal(pt.status, 200);
    assert.equal(pt.json().name, "Bobby");
    assert.equal(pt.json().autoReply, false);
    assert.deepEqual(pt.json().allowedMcpTools, ["mcp__fs__read"]);
    assert.ok(A.agent().changed.includes(ch));
    assert.equal((await http(port, "PATCH", `/api/channels/${ch}`, { headers: H, body: { autoReply: "yes" } })).status, 400);

    // --- transfers + mcp (stubs)
    assert.deepEqual((await http(port, "GET", "/api/transfers", { headers: H })).json(), { items: [] });
    const tq = await http(port, "POST", "/api/transfers", { headers: H, body: { ch, path: "/tmp/x" } });
    assert.equal(tq.status, 200);
    assert.equal(A.transfers().requests[0].req.initiatedBy, "owner");
    assert.equal((await http(port, "POST", "/api/transfers/abc/approve", { headers: H })).status, 404);
    assert.deepEqual((await http(port, "GET", "/api/mcp", { headers: H })).json(), { servers: [] });
    assert.equal((await http(port, "GET", "/api/nope", { headers: H })).status, 404);

    // --- body limit
    assert.equal((await http(port, "POST", "/api/owner/messages", { headers: H, body: { text: "x".repeat(1024 * 1024 + 10) } })).status, 413);

    // --- leave
    assert.equal((await http(port, "DELETE", `/api/channels/${ch}`, { headers: H })).status, 200);
    assert.equal((await http(port, "GET", "/api/state", { headers: H })).json().channels.length, 0);
    assert.ok(events.some((e) => e.type === "channel_removed" && e.ch === ch));
  } finally {
    for (const s of sockets) s.terminate();
    await A.daemon.stop();
    await B.daemon.stop();
    await relay.close();
    t.cleanup();
  }
});

test("http api: experimental features are off by default; the gates answer 403 until they are turned on", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  mkdirSync(join(t.dir, "a"));
  mkdirSync(join(t.dir, "b"));
  const A = await startNode(join(t.dir, "a"), relay.url, "Alice");
  const B = await startNode(join(t.dir, "b"), relay.url, "Bob");
  try {
    const port = A.daemon.port;
    const H = { "X-Spencer-Token": A.daemon.token };
    const direct = (await http(port, "POST", "/api/invites", { headers: H, body: { kind: "group", name: "Plain" } })).json().channel;

    assert.equal((await http(port, "GET", "/api/state", { headers: H })).json().experimental, false);
    assert.equal((await http(port, "GET", "/api/soul", { headers: H })).status, 403);
    assert.equal((await http(port, "PUT", "/api/model/conversation", { headers: H, body: { provider: null } })).status, 403);
    assert.equal((await http(port, "POST", "/api/invites", { headers: H, body: { kind: "conversation", name: "Debates" } })).status, 403);
    assert.equal((await http(port, "GET", `/api/channels/${direct.id}/conversation`, { headers: H })).status, 403);
    assert.equal((await http(port, "PATCH", `/api/channels/${direct.id}`, { headers: H, body: { heated: true } })).status, 403);
    await assert.rejects(A.daemon.core.createInvite("conversation", "Debates"), /experimental/, "the agent's create_invite path too");

    assert.equal((await http(port, "PUT", "/api/experimental", { headers: H, body: { enabled: "yes" } })).status, 400);
    const on = await http(port, "PUT", "/api/experimental", { headers: H, body: { enabled: true } });
    assert.deepEqual(on.json(), { enabled: true });
    assert.equal(A.agent().experimentalChanges, 1);
    assert.equal(JSON.parse(readFileSync(join(t.dir, "a", "config.json"), "utf8")).experimental, true, "saved in config.json");
    assert.equal((await http(port, "GET", "/api/state", { headers: H })).json().experimental, true);
    await http(port, "PUT", "/api/experimental", { headers: H, body: { enabled: true } });
    assert.equal(A.agent().experimentalChanges, 1, "no change, nothing re-applied");

    const inv = await http(port, "POST", "/api/invites", { headers: H, body: { kind: "conversation", name: "Debates" } });
    assert.equal(inv.status, 200);
    const convo = inv.json().channel;
    assert.equal(convo.mode, "conversation");
    assert.equal(convo.heated, false);
    assert.equal((await http(port, "PATCH", `/api/channels/${direct.id}`, { headers: H, body: { heated: true } })).status, 400, "only Conversations channels");
    const hot = await http(port, "PATCH", `/api/channels/${convo.id}`, { headers: H, body: { heated: true } });
    assert.equal(hot.status, 200);
    assert.equal(hot.json().heated, true);

    // A person writing in a Conversations channel: the agent gives the message its conversation, peers get it.
    const ok = await http(B.daemon.port, "POST", "/api/invites/accept", { headers: { "X-Spencer-Token": B.daemon.token }, body: { link: inv.json().link } });
    assert.equal(ok.status, 200);
    await waitFor(() => A.daemon.core.getChannel(convo.id)!.members.length === 2, "joined");
    const ref = { id: "C".repeat(22), start: true as const, heated: true as const };
    A.agent().convoRef = ref;
    const sent = (await http(port, "POST", `/api/channels/${convo.id}/messages`, { headers: H, body: { text: "yo" } })).json();
    await waitFor(() => A.agent().outgoing.some((o) => o.id === sent.id), "outgoing");
    assert.deepEqual(A.agent().outgoing.find((o) => o.id === sent.id)!.convo, ref, "the agent learns which conversation it started");
    await waitFor(() => B.agent().peerChats.some((c) => c.id === sent.id), "B got it");
    assert.deepEqual(B.agent().peerChats.find((c) => c.id === sent.id)!.body.convo, ref);
    // Not in a plain group.
    const plain = (await http(port, "POST", `/api/channels/${direct.id}/messages`, { headers: H, body: { text: "hi" } })).json();
    await waitFor(() => A.agent().outgoing.some((o) => o.id === plain.id), "outgoing plain");
    assert.equal(A.agent().outgoing.find((o) => o.id === plain.id)!.convo, undefined);

    await http(port, "PUT", "/api/experimental", { headers: H, body: { enabled: false } });
    assert.equal((await http(port, "PATCH", `/api/channels/${convo.id}`, { headers: H, body: { heated: false } })).status, 403);
    assert.equal((await http(port, "PATCH", `/api/channels/${convo.id}`, { headers: H, body: { name: "Still renamable" } })).status, 200);
  } finally {
    await A.daemon.stop();
    await B.daemon.stop();
    await relay.close();
    t.cleanup();
  }
});

test("http api: placeholder page when the web UI is not installed", async () => {
  const t = tempDir();
  const A = await startNode(t.dir, "ws://127.0.0.1:1/ws", "Solo");
  try {
    const r = await http(A.daemon.port, "GET", "/");
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(A.daemon.token));
    assert.ok(r.text.includes("Spencer is running"));
  } finally {
    await A.daemon.stop();
    t.cleanup();
  }
});
