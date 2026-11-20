import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { freePort, relayAt, startNode, tempDir, waitFor, sleep, type Relay, type TestNode } from "./helpers.ts";

type OutboxRow = { id: string; state: string; seq: number | null; env: string; idempotency_key: string | null };

function outboxRow(n: TestNode, id: string): OutboxRow | undefined {
  return n.daemon.db.prepare("SELECT id, state, seq, env, idempotency_key FROM outbox WHERE id = ?").get(id) as OutboxRow | undefined;
}

async function pair(t: { dir: string }, relayUrl: string): Promise<{ A: TestNode; B: TestNode; ch: string }> {
  const da = join(t.dir, "a");
  const db = join(t.dir, "b");
  mkdirSync(da);
  mkdirSync(db);
  const A = await startNode(da, relayUrl, "Alice");
  const B = await startNode(db, relayUrl, "Bob");
  const { link, channel } = await A.daemon.createInvite("direct", "Bob");
  await B.daemon.acceptInvite(link);
  await waitFor(() => A.daemon.core.getChannel(channel.id)?.members.length === 2, "joined");
  return { A, B, ch: channel.id };
}

test("outbox: enqueue while the relay is down, delivered once it is back", async () => {
  const t = tempDir();
  const port = await freePort();
  let relay: Relay | undefined = await relayAt(t.dir, port);
  const { A, B, ch } = await pair(t, relay.url);
  try {
    await relay.close();
    relay = undefined;
    await waitFor(() => !A.daemon.pool.isConnected(A.daemon.core.getChannel(ch)!.relayUrl), "A disconnected");

    const m = A.daemon.sendHuman(ch, "sent while offline");
    await sleep(200);
    assert.equal(outboxRow(A, m.id)!.state, "pending");
    assert.equal(A.daemon.core.readChannel(ch, 10).find((x) => x.id === m.id)!.status, "pending");

    // Survives a restart of the sender too.
    await A.restart();
    assert.equal(outboxRow(A, m.id)!.state, "pending");

    relay = await relayAt(t.dir, port);
    await waitFor(() => outboxRow(A, m.id)?.state === "sent", "sent after relay is back", 10_000);
    await waitFor(() => B.agent().peerChats.some((c) => c.id === m.id), "B received", 10_000);
    assert.equal(A.daemon.core.readChannel(ch, 10).find((x) => x.id === m.id)!.status, "sent");
  } finally {
    await A.daemon.stop();
    await B.daemon.stop();
    await relay?.close();
    t.cleanup();
  }
});

test("outbox: idempotency key dedupes; a resend after a lost ack gets the same seq", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const { A, B, ch } = await pair(t, relay.url);
  try {
    const first = A.daemon.core.sendChat(ch, { text: "once", hop: 1, by: "agent", origin: "agent-reply", idempotencyKey: "k1" });
    const second = A.daemon.core.sendChat(ch, { text: "twice?", hop: 1, by: "agent", origin: "agent-reply", idempotencyKey: "k1" });
    assert.equal(second.id, first.id);
    const n = (A.daemon.db.prepare("SELECT count(*) AS n FROM outbox WHERE idempotency_key = 'k1'").get() as { n: number }).n;
    assert.equal(n, 1);
    // Enqueue inside a caller's transaction that rolls back leaves nothing behind.
    A.daemon.db.exec("BEGIN");
    const ghost = A.daemon.outbox.enqueue(ch, { type: "chat", text: "ghost", hop: 0, by: "human" });
    A.daemon.db.exec("ROLLBACK");
    assert.equal(outboxRow(A, ghost.id), undefined);

    await waitFor(() => outboxRow(A, first.id)?.state === "sent", "sent");
    const seq1 = outboxRow(A, first.id)!.seq;
    assert.ok(seq1 && seq1 > 0);
    await waitFor(() => B.agent().peerChats.some((c) => c.id === first.id), "B got it");

    // Simulate a lost `ok`: the row goes back to pending and the identical envelope is resent.
    const envBefore = outboxRow(A, first.id)!.env;
    A.daemon.db.prepare("UPDATE outbox SET state = 'pending', seq = NULL WHERE id = ?").run(first.id);
    A.daemon.outbox.kick(ch);
    await waitFor(() => outboxRow(A, first.id)?.state === "sent", "resent");
    assert.equal(outboxRow(A, first.id)!.seq, seq1);
    assert.equal(outboxRow(A, first.id)!.env, envBefore);
    // A later message gets a fresh seq, and B saw the first exactly once.
    const later = A.daemon.sendHuman(ch, "later");
    await waitFor(() => B.agent().peerChats.some((c) => c.id === later.id), "later delivered");
    assert.ok(outboxRow(A, later.id)!.seq! > seq1);
    assert.deepEqual(
      B.agent().peerChats.map((c) => c.id),
      [first.id, later.id],
    );
    assert.equal(ghost.id.length, 22);
  } finally {
    await A.daemon.stop();
    await B.daemon.stop();
    await relay.close();
    t.cleanup();
  }
});
