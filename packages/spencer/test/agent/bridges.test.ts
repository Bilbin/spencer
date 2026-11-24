import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findT3, t3Tools } from "../../src/bridges/t3.ts";
import { VIA, spencerTools } from "../../src/bridges/spencer.ts";
import { McpManager } from "../../src/agent/mcp.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "spencer-bridge-"));
const MAIN = new URL("../../src/main.ts", import.meta.url).pathname;

test("findT3: T3_BIN, then PATH, then the newest ~/.t3 runtime version", () => {
  const home = tmp();
  try {
    for (const v of ["0.1.9", "0.1.10", "0.2.0-beta"]) mkdirSync(join(home, ".t3/runtime/versions", v), { recursive: true });
    writeFileSync(join(home, ".t3/runtime/versions/0.1.9/t3"), "");
    writeFileSync(join(home, ".t3/runtime/versions/0.1.10/t3"), "");
    for (const v of ["0.1.9", "0.1.10"]) writeFileSync(join(home, ".t3/runtime/versions", v, ".install-complete"), "");
    mkdirSync(join(home, ".t3/runtime/versions/0.1.11"));
    writeFileSync(join(home, ".t3/runtime/versions/0.1.11/t3"), "");
    assert.equal(findT3({ PATH: "" }, home), join(home, ".t3/runtime/versions/0.1.10/t3"), "numeric order; a version without t3 or still installing is skipped");
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin/t3"), "");
    assert.equal(findT3({ PATH: join(home, "bin") }, home), join(home, "bin/t3"));
    assert.equal(findT3({ T3_BIN: "/opt/t3", PATH: join(home, "bin") }, home), "/opt/t3");
    assert.equal(findT3({ PATH: "" }, join(home, "nope")), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("spencer mcp t3: tools run the t3 CLI (message on stdin) and report its errors", async () => {
  const dir = tmp();
  const bin = join(dir, "t3");
  // A fake t3: prints its arguments and stdin; `thread show bad` fails like the real one.
  writeFileSync(bin, '#!/bin/sh\nif [ "$3" = bad ]; then echo "thread bad not found" >&2; exit 1; fi\necho "$*" >> "$0.calls"\necho "args: $*"\necho "stdin: $(cat)"\n');
  chmodSync(bin, 0o755);
  const mgr = new McpManager({ t3code: { command: process.execPath, args: [MAIN, "mcp", "t3"], env: { T3_BIN: bin, T3_PROJECT: "/work/proj" } } });
  try {
    mgr.start();
    await mgr.settled();
    assert.deepEqual(
      mgr.status()[0]!.tools.map((t) => t.name),
      ["mcp__t3code__thread_list", "mcp__t3code__thread_start", "mcp__t3code__thread_send", "mcp__t3code__thread_show"],
    );
    assert.match((await mgr.call("t3code", "thread_list", {})).text, /^args: thread list --project \/work\/proj/);
    const started = await mgr.call("t3code", "thread_start", { message: "fix the 'bug'\nplease", title: "Fix", project: "." });
    assert.equal(started.isError, false);
    assert.match(started.text, /args: thread start --json --title Fix \. -/);
    assert.match(started.text, /stdin: fix the 'bug'\nplease/);
    assert.match(started.text, /runs in the background/);
    assert.match((await mgr.call("t3code", "thread_send", { thread: "t1", message: "go" })).text, /^Sent to thread t1\./);
    assert.deepEqual(await mgr.call("t3code", "thread_show", { thread: "bad" }), { text: "thread bad not found", isError: true });
    assert.deepEqual(await mgr.call("t3code", "thread_send", { thread: "t1" }), { text: "message is required", isError: true });
    const calls = () => readFileSync(`${bin}.calls`, "utf8").split("\n").length;
    const n = calls();
    assert.equal((await mgr.call("t3code", "thread_start", { message: "x", wait_seconds: "30s" })).isError, true);
    assert.equal(calls(), n, "a bad argument is caught before a thread is started");
  } finally {
    await mgr.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spencer mcp spencer: channels, reading and asking go through the local API with the token", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ pid: 1, port: 7999 }));
  writeFileSync(join(dir, "api-token"), "tok\n");
  const owner: { id: string; role: string; text: string; ts: number }[] = [{ id: "o1", role: "assistant", text: "old", ts: 1 }];
  let busy = false;
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    assert.equal((init.headers as Record<string, string>)["X-Spencer-Token"], "tok");
    assert.equal(u.host, "127.0.0.1:7999");
    calls.push(`${init.method} ${u.pathname}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (u.pathname === "/api/state")
      return json({
        me: { name: "Nick" },
        ownerBusy: busy,
        channels: [
          { id: "c1", kind: "group", name: "Platform", unread: 2, autoReply: true, members: [{ me: true, presence: "online" }, { name: "Max", me: false, presence: "online" }] },
        ],
      });
    if (u.pathname === "/api/channels/c1/messages")
      return json({ items: [{ id: "m1", type: "chat", from: "x", fromName: "Max", mine: false, ts: 0, text: "hi", by: "agent", note: "not addressed" }] });
    if (u.pathname === "/api/owner/messages" && init.method === "POST") {
      owner.push({ id: "o2", role: "user", text: JSON.parse(String(init.body)).text, ts: 2 });
      busy = true;
      setTimeout(() => {
        owner.push({ id: "o3", role: "tool", text: "call", ts: 3 }, { id: "o4", role: "assistant", text: "Done: 42", ts: 4 });
        busy = false;
      }, 1500);
      return json({ submissionId: "s" });
    }
    if (u.pathname === "/api/owner/messages") return json({ items: owner });
    return json({ error: "nope" }, 404);
  }) as typeof fetch;
  const tools = Object.fromEntries(spencerTools(dir, fakeFetch).map((t) => [t.name, t]));
  try {
    assert.match(await tools.spencer_channels!.run({}), /- Platform \[c1\] group, 2 unread: Max \(online\)/);
    assert.match(await tools.spencer_read_channel!.run({ channel: "platform" }), /Max: hi \(no reply: not addressed\)/);
    await assert.rejects(tools.spencer_read_channel!.run({ channel: "nope" }), /no channel "nope". Channels: Platform \(c1\)/);
    const answer = await tools.spencer_ask!.run({ message: "what is 6*7?", wait_seconds: 20 });
    assert.equal(answer, "Spencer: Done: 42");
    assert.equal(owner[1]!.text, `${VIA} what is 6*7?`, "marked as coming from another agent");
    assert.ok(calls.includes("POST /api/owner/messages"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
