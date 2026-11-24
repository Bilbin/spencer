import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { request as httpRequest, type ClientRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { SpencerAgent } from "../../src/agent/agent.ts";
import { Daemon } from "../../src/daemon.ts";
import { FAST, http, quietLog, relayAt, StubTransfers, tempDir, type HttpResult } from "./helpers.ts";

const requestId = "owner-send-key-0001";
const uploadId = "owner-upload-key-0001";

type Gate<T = void> = { promise: Promise<T>; resolve(value: T): void };
function gate<T = void>(): Gate<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type SendHook = (agent: SpencerAgent) => void;
interface RunningAgent {
  daemon: Daemon;
}

async function startAgent(dir: string, relayUrl: string, onSend?: SendHook): Promise<RunningAgent> {
  const daemon = new Daemon({
    dataDir: dir,
    config: { name: "Owner Send Test", relay: relayUrl, http: { host: "127.0.0.1", port: 0 }, model: { provider: "fake" }, p2p: { mode: "off", hideLocalAddresses: true, minFileBytes: 0, stun: [] } },
    agentFactory: (core) => {
      const agent = new SpencerAgent(core, { log: quietLog });
      onSend?.(agent);
      return agent;
    },
    transferFactory: (deps) => new StubTransfers(deps),
    log: quietLog,
    webRoot: null,
    tuning: FAST,
  });
  await daemon.start();
  return { daemon };
}

function send(daemon: Daemon, id: string, text: string, attachments: string[] = []): Promise<HttpResult> {
  return http(daemon.port, "POST", "/api/owner/messages", {
    headers: { "X-Spencer-Token": daemon.token },
    body: { requestId: id, text, attachments },
  });
}

function sendPending(daemon: Daemon, id: string, text: string, attachments: string[] = []): { result: Promise<HttpResult>; abort(): void } {
  const data = Buffer.from(JSON.stringify({ requestId: id, text, attachments }));
  let req!: ClientRequest;
  const result = new Promise<HttpResult>((resolve, reject) => {
    req = httpRequest({
      host: "127.0.0.1", port: daemon.port, method: "POST", path: "/api/owner/messages", agent: false,
      headers: {
        Host: `127.0.0.1:${daemon.port}`,
        "X-Spencer-Token": daemon.token,
        "Content-Type": "application/json",
        "Content-Length": String(data.length),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
  void result.catch(() => {});
  return { result, abort: () => req.destroy(new Error("simulated client disconnect")) };
}

function dropResponseAfterHeaders(daemon: Daemon, id: string, text: string, attachments: string[]): Promise<number> {
  const data = Buffer.from(JSON.stringify({ requestId: id, text, attachments }));
  return new Promise((resolve, reject) => {
    let received = false;
    const req = httpRequest({
      host: "127.0.0.1", port: daemon.port, method: "POST", path: "/api/owner/messages", agent: false,
      headers: {
        Host: `127.0.0.1:${daemon.port}`,
        "X-Spencer-Token": daemon.token,
        "Content-Type": "application/json",
        "Content-Length": String(data.length),
      },
    }, (res) => {
      received = true;
      const status = res.statusCode ?? 0;
      res.destroy();
      resolve(status);
    });
    req.on("error", (error) => { if (!received) reject(error); });
    req.end(data);
  });
}

async function upload(daemon: Daemon, name: string, id: string, contents: string): Promise<string> {
  const result = await http(daemon.port, "POST", `/api/owner/attachments/upload?name=${encodeURIComponent(name)}&uploadId=${id}`, {
    headers: { "X-Spencer-Token": daemon.token, "Content-Type": "application/octet-stream" },
    body: Buffer.from(contents),
  });
  assert.equal(result.status, 200, result.text);
  return result.json().id as string;
}

function expireAttachment(dir: string, id: string): void {
  const db = new DatabaseSync(join(dir, "spencer.sqlite"));
  try {
    db.prepare("UPDATE owner_attachments SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1, id);
  } finally {
    db.close();
  }
}

async function transcript(daemon: Daemon): Promise<{ id: string; role: string; text: string }[]> {
  const result = await http(daemon.port, "GET", "/api/owner/messages?limit=200", {
    headers: { "X-Spencer-Token": daemon.token },
  });
  assert.equal(result.status, 200, result.text);
  return result.json().items;
}

test("equal concurrent owner sends return one durable submission", async () => {
  const tmp = tempDir("spencer-owner-send-equal-");
  const relay = await relayAt(tmp.dir);
  const submitted = gate<string>();
  const release = gate();
  let node: RunningAgent | undefined;
  try {
    node = await startAgent(tmp.dir, relay.url, (agent) => {
      const original = agent.ownerSend.bind(agent);
      let calls = 0;
      agent.ownerSend = async (text, options) => {
        const result = await original(text, options);
        if (calls++ === 0) {
          submitted.resolve(result.submissionId);
          await release.promise;
        }
        return result;
      };
    });
    const first = sendPending(node.daemon, requestId, "same text");
    const originalSubmission = await submitted.promise;
    const second = await send(node.daemon, requestId, "same text");
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json().submissionId, originalSubmission);
    release.resolve();
    const accepted = await first.result;
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.json().submissionId, originalSubmission);
    const users = (await transcript(node.daemon)).filter((item) => item.role === "user" && item.text === "same text");
    assert.equal(users.length, 1, "a retry creates one owner transcript entry");
  } finally {
    release.resolve();
    await node?.daemon.stop();
    await relay.close();
    tmp.cleanup();
  }
});

test("concurrent conflicting content cannot claim a request ID after runtime submission", async () => {
  const tmp = tempDir("spencer-owner-send-concurrent-");
  const relay = await relayAt(tmp.dir);
  const submitted = gate<string>();
  const release = gate();
  let node: RunningAgent | undefined;
  try {
    node = await startAgent(tmp.dir, relay.url, (agent) => {
      const original = agent.ownerSend.bind(agent);
      agent.ownerSend = async (text, options) => {
        const result = await original(text, options);
        if (text === "original text") {
          submitted.resolve(result.submissionId);
          await release.promise;
        }
        return result;
      };
    });
    const first = sendPending(node.daemon, requestId, "original text");
    const originalSubmission = await submitted.promise;
    const conflicting = await send(node.daemon, requestId, "different text");
    assert.equal(conflicting.status, 409, conflicting.text);
    release.resolve();
    const accepted = await first.result;
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.json().submissionId, originalSubmission);
    const users = (await transcript(node.daemon)).filter((item) => item.role === "user");
    assert.deepEqual(users.map((item) => item.text), ["original text"]);
  } finally {
    release.resolve();
    await node?.daemon.stop();
    await relay.close();
    tmp.cleanup();
  }
});

test("a reserved send binds its content across restart before runtime submission", async () => {
  const tmp = tempDir("spencer-owner-send-reserved-");
  const relay = await relayAt(tmp.dir);
  const beforeSubmit = gate();
  const entered = gate();
  let stopOldSend = false;
  let node: RunningAgent | undefined;
  try {
    node = await startAgent(tmp.dir, relay.url, (agent) => {
      const original = agent.ownerSend.bind(agent);
      agent.ownerSend = async (text, options) => {
        entered.resolve();
        await beforeSubmit.promise;
        if (stopOldSend) throw new Error("simulated stop before runtime submission");
        return original(text, options);
      };
    });
    const attachmentId = await upload(node.daemon, "notes.txt", uploadId, "private attachment bytes");
    const pending = sendPending(node.daemon, requestId, "original text", [attachmentId]);
    await entered.promise;
    pending.abort();
    await node.daemon.stop();
    stopOldSend = true;
    beforeSubmit.resolve();
    await assert.rejects(pending.result);

    node = await startAgent(tmp.dir, relay.url);
    const conflicting = await send(node.daemon, requestId, "different text", [attachmentId]);
    assert.equal(conflicting.status, 409, conflicting.text);
    const recovered = await send(node.daemon, requestId, "original text", [attachmentId]);
    assert.equal(recovered.status, 200, recovered.text);
    const users = (await transcript(node.daemon)).filter((item) => item.role === "user");
    assert.deepEqual(users.map((item) => item.text), ["original text"]);
  } finally {
    beforeSubmit.resolve();
    await node?.daemon.stop();
    await relay.close();
    tmp.cleanup();
  }
});

test("a runtime submission interrupted before API result recording replays only its original content", async () => {
  const tmp = tempDir("spencer-owner-send-submitted-");
  const relay = await relayAt(tmp.dir);
  const submitted = gate<string>();
  const release = gate();
  let node: RunningAgent | undefined;
  try {
    node = await startAgent(tmp.dir, relay.url, (agent) => {
      const original = agent.ownerSend.bind(agent);
      agent.ownerSend = async (text, options) => {
        const result = await original(text, options);
        submitted.resolve(result.submissionId);
        await release.promise;
        return result;
      };
    });
    const pending = sendPending(node.daemon, requestId, "original text");
    const originalSubmission = await submitted.promise;
    pending.abort();
    await node.daemon.stop();
    release.resolve();
    await assert.rejects(pending.result);
    const core = new DatabaseSync(join(tmp.dir, "spencer.sqlite"));
    try {
      const reservation = core.prepare("SELECT state, submission_id FROM owner_send_idempotency WHERE request_id = ?").get(requestId) as
        | { state: string; submission_id: string }
        | undefined;
      assert.equal(reservation?.state, "reserved", "the content binding committed before the API result");
      assert.equal(reservation?.submission_id, "");
    } finally {
      core.close();
    }

    node = await startAgent(tmp.dir, relay.url);
    const conflicting = await send(node.daemon, requestId, "different text");
    assert.equal(conflicting.status, 409, conflicting.text);
    const replay = await send(node.daemon, requestId, "original text");
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json().submissionId, originalSubmission);
    const users = (await transcript(node.daemon)).filter((item) => item.role === "user");
    assert.deepEqual(users.map((item) => item.text), ["original text"]);
  } finally {
    release.resolve();
    await node?.daemon.stop();
    await relay.close();
    tmp.cleanup();
  }
});

test("failed owner submission stays reserved until an identical retry is accepted", async () => {
  const tmp = tempDir("spencer-owner-send-failed-");
  const relay = await relayAt(tmp.dir);
  let attempts = 0;
  let node: RunningAgent | undefined;
  try {
    node = await startAgent(tmp.dir, relay.url, (agent) => {
      const original = agent.ownerSend.bind(agent);
      agent.ownerSend = async (text, options) => {
        if (attempts++ === 0) throw new Error("simulated failure before submission");
        return original(text, options);
      };
    });
    const failed = await send(node.daemon, requestId, "original text");
    assert.equal(failed.status, 500, failed.text);
    const conflicting = await send(node.daemon, requestId, "different text");
    assert.equal(conflicting.status, 409, conflicting.text);
    const retry = await send(node.daemon, requestId, "original text");
    assert.equal(retry.status, 200, retry.text);
    const users = (await transcript(node.daemon)).filter((item) => item.role === "user");
    assert.deepEqual(users.map((item) => item.text), ["original text"]);
  } finally {
    await node?.daemon.stop();
    await relay.close();
    tmp.cleanup();
  }
});

test("accepted retry survives restart after attachment cleanup and a lost response body", async () => {
  const tmp = tempDir("spencer-owner-send-result-");
  const relay = await relayAt(tmp.dir);
  const returned = gate<string>();
  let node: RunningAgent | undefined;
  try {
    node = await startAgent(tmp.dir, relay.url, (agent) => {
      const original = agent.ownerSend.bind(agent);
      agent.ownerSend = async (text, options) => {
        const result = await original(text, options);
        returned.resolve(result.submissionId);
        return result;
      };
    });
    const attachmentId = await upload(node.daemon, "notes.txt", uploadId, "private attachment bytes");
    const submission = returned.promise;
    const status = await dropResponseAfterHeaders(node.daemon, requestId, "original text", [attachmentId]);
    assert.equal(status, 200);
    const originalSubmission = await submission;
    expireAttachment(tmp.dir, attachmentId);
    await node.daemon.stop();

    node = await startAgent(tmp.dir, relay.url);
    const replay = await send(node.daemon, requestId, "original text", [attachmentId]);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json().submissionId, originalSubmission);
    const unavailable = await send(node.daemon, "owner-send-key-0002", "new text", [attachmentId]);
    assert.equal(unavailable.status, 400, unavailable.text);
    const users = (await transcript(node.daemon)).filter((item) => item.role === "user");
    assert.deepEqual(users.map((item) => item.text), ["original text"]);
  } finally {
    await node?.daemon.stop();
    await relay.close();
    tmp.cleanup();
  }
});
