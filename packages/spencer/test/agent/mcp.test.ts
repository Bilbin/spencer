import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { McpManager, mcpToolName } from "../../src/agent/mcp.ts";
import { SpencerAgent } from "../../src/agent/agent.ts";
import type { FakeRequestInfo } from "../../src/agent/fake-brain.ts";
import type { DaemonEvent } from "../../src/contracts.ts";
import { channel, makeCore, peerChat, waitFor } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-mcp-server.ts", import.meta.url));
const ECHO = { command: process.execPath, args: [FIXTURE] };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("mcpToolName sanitizes and caps at 64 chars", () => {
  assert.equal(mcpToolName("echo", "echo"), "mcp__echo__echo");
  assert.equal(mcpToolName("my-srv", "do.thing/now"), "mcp__my_srv__do_thing_now");
  assert.equal(mcpToolName("s", "x".repeat(100)).length, 64);
});

test("McpManager: connects a stdio server, lists and calls tools, stops its child", async () => {
  const events: DaemonEvent[] = [];
  const mgr = new McpManager({ echo: ECHO, off: { command: "nonexistent-binary", disabled: true } }, { events: { emit: (e) => events.push(e) } });
  mgr.start();
  await mgr.settled();
  const status = mgr.status();
  const echo = status.find((s) => s.name === "echo")!;
  assert.equal(echo.status, "connected");
  assert.equal(echo.transport, "stdio");
  assert.deepEqual(
    echo.tools.map((t) => t.name),
    ["mcp__echo__echo", "mcp__echo__pid", "mcp__echo__fail", "mcp__echo__big"],
  );
  assert.equal(status.find((s) => s.name === "off")!.status, "disabled");
  assert.ok(events.some((e) => e.type === "mcp" && e.servers.some((s) => s.status === "connected")));

  const tool = mgr.tools().find((t) => t.name === "mcp__echo__echo")!;
  assert.deepEqual(await tool.execute({ text: "hi" }, { conversationKey: "owner", callId: "c1" }), { text: "echo: hi", isError: false });
  assert.deepEqual(await mgr.call("echo", "fail", {}), { text: "it failed", isError: true });
  const big = await mgr.call("echo", "big", {});
  assert.ok(Buffer.byteLength(big.text) <= 32 * 1024 + 64 && big.text.endsWith("[truncated to 32 KB]"));
  const pid = Number((await mgr.call("echo", "pid", {})).text);
  assert.ok(alive(pid));

  await mgr.stop();
  assert.equal(alive(pid), false, "no orphan child after stop");
  assert.deepEqual(await mgr.call("echo", "echo", { text: "x" }), { text: "MCP server echo is not connected.", isError: true });
});

test("McpManager: a failing server reports an error and does not block", async () => {
  const mgr = new McpManager({ broken: { command: process.execPath, args: ["-e", "process.exit(3)"] } });
  mgr.start();
  await mgr.settled();
  const s = mgr.status()[0]!;
  assert.equal(s.status, "error");
  assert.ok(s.error);
  assert.deepEqual(mgr.tools(), []);
  await mgr.stop();
});

test("agent: owner /tool calls an MCP tool end to end; channels get only allowed MCP tools", async () => {
  const core = makeCore({
    channels: [channel("chA", "direct", "Allowed", { allowedMcpTools: ["mcp__echo__echo"] }), channel("chB", "direct", "Plain")],
    config: { mcpServers: { echo: ECHO } },
  });
  const requests: FakeRequestInfo[] = [];
  const agent = new SpencerAgent(core, { fakeHooks: { onRequest: (i) => requests.push(i) }, log: () => {} });
  await agent.start();
  let pid = 0;
  try {
    await agent.mcpSettled();
    assert.equal(agent.mcpStatus()[0]!.status, "connected");
    await agent.ownerSend('/tool mcp__echo__echo {"text":"hi"}');
    await agent.idle();
    const items = await agent.ownerTranscript(10);
    assert.deepEqual(items.at(-1), { ...items.at(-1)!, role: "assistant", text: "done: echo: hi" });
    assert.ok(items.some((i) => i.role === "tool" && i.toolName === "mcp__echo__echo" && i.text === "echo: hi"));

    assert.deepEqual(await agent.agentRuntime!.offeredTools("ch:chA"), ["notify_owner", "ask_owner", "propose_file_send", "mcp__echo__echo"]);
    assert.deepEqual(await agent.agentRuntime!.offeredTools("ch:chB"), ["notify_owner", "ask_owner", "propose_file_send"]);
    await agent.onPeerChat(peerChat(core.getChannel("chB")!, "hello"));
    await agent.idle();
    const chReq = requests.find((r) => r.conversation === "channel")!;
    assert.ok(!chReq.tools.some((t) => t.startsWith("mcp__")));

    // Revoking the permission takes effect on channelChanged.
    core.channels.set("chA", { ...core.getChannel("chA")!, allowedMcpTools: [] });
    await agent.channelChanged("chA");
    assert.deepEqual(await agent.agentRuntime!.offeredTools("ch:chA"), ["notify_owner", "ask_owner", "propose_file_send"]);

    await agent.ownerSend("/tool mcp__echo__pid {}");
    await agent.idle();
    pid = Number((await agent.ownerTranscript(1))[0]!.text.replace("done: ", ""));
    assert.ok(pid > 0 && alive(pid));
  } finally {
    await agent.stop();
    core.cleanup();
  }
  assert.equal(alive(pid), false, "MCP child gone after agent.stop()");
});

test("agent: a full-trust channel gets every MCP tool; calls leave an audit note for the owner", async () => {
  const core = makeCore({
    channels: [channel("chFull", "direct", "Trusted", { trust: "full" })],
    config: { mcpServers: { echo: ECHO } },
  });
  const agent = new SpencerAgent(core, { log: () => {} });
  await agent.start();
  try {
    await agent.mcpSettled();
    const offered = await agent.agentRuntime!.offeredTools("ch:chFull");
    assert.deepEqual(offered.slice(0, 3), ["notify_owner", "ask_owner", "propose_file_send"]);
    assert.ok(offered.includes("mcp__echo__echo") && offered.includes("mcp__echo__pid"));
    await agent.onPeerChat(peerChat(core.getChannel("chFull")!, 'please call mcp__echo__echo {"text":"from bob"}'));
    await agent.idle();
    assert.equal(core.sent.at(-1)!.text, "done: echo: from bob");
    await waitFor(async () => (await agent.ownerTranscript(20)).some((i) => i.role === "note" && i.text.includes("mcp__echo__echo")));
    const note = (await agent.ownerTranscript(20)).find((i) => i.role === "note" && i.text.includes("mcp__echo__echo"))!;
    assert.ok(note.untrusted);
    assert.match(note.text, /^Trusted \(full trust\): your Spencer called mcp__echo__echo/);

    // Back to standard: only the allow-listed tools (none).
    core.channels.set("chFull", { ...core.getChannel("chFull")!, trust: "standard" });
    await agent.channelChanged("chFull");
    assert.deepEqual(await agent.agentRuntime!.offeredTools("ch:chFull"), ["notify_owner", "ask_owner", "propose_file_send"]);
  } finally {
    await agent.stop();
    core.cleanup();
  }
});
