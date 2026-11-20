import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, decideReply, isAddressed, loopLimits, nameHandles, parseAgentAnswer, textMentions } from "../../src/policy.ts";
import { DEFAULT_POLICY, resolveConfig } from "../../src/config.ts";

const base = {
  channelKind: "direct" as const,
  autoReply: true,
  hop: 0,
  maxHops: 4,
  text: "hello",
  myId: "ME",
  myName: "Alice's Spencer",
};

test("decideReply: direct channel replies", () => {
  assert.deepEqual(decideReply(base), { reply: true });
});

test("decideReply: auto-reply off wins", () => {
  assert.deepEqual(decideReply({ ...base, autoReply: false, hop: 99 }), { reply: false, note: "auto-reply off" });
});

test("decideReply: hop cap at hop >= maxHops", () => {
  assert.deepEqual(decideReply({ ...base, hop: 3 }), { reply: true });
  assert.deepEqual(decideReply({ ...base, hop: 4 }), { reply: false, note: "hop cap" });
  assert.deepEqual(decideReply({ ...base, hop: 9, channelKind: "group" }), { reply: false, note: "hop cap" });
});

test("decideReply: group needs addressing", () => {
  const g = { ...base, channelKind: "group" as const };
  assert.deepEqual(decideReply(g), { reply: false, note: "not addressed" });
  assert.deepEqual(decideReply({ ...g, mentions: ["OTHER", "ME"] }), { reply: true });
  assert.deepEqual(decideReply({ ...g, text: "hey @Alice's Spencer, status?" }), { reply: true });
  assert.deepEqual(decideReply({ ...g, mentions: ["OTHER"] }), { reply: false, note: "not addressed" });
});

test("name handles and @-matching", () => {
  assert.deepEqual(nameHandles("Alice's Spencer").sort(), ["alice", "alicesspencer"].sort());
  for (const t of ["@Alice's Spencer hi", "@alice: hi", "yo @ALICE", "@alices-spencer ping", "@AlicesSpencer!", "(@alice)"]) {
    assert.equal(textMentions(t, "Alice's Spencer"), true, t);
  }
  for (const t of ["alice hi", "@alicex", "@bob", "email alice@example.com", "@ alice"]) {
    assert.equal(textMentions(t, "Alice's Spencer"), false, t);
  }
  assert.equal(textMentions("@Bob Smith please", "Bob Smith's Spencer"), true);
  assert.equal(textMentions("@bobsmith please", "Bob Smith's Spencer"), true);
  assert.equal(textMentions("@spencer", "Spencer"), true);
});

test("agent-written messages with explicit mentions are addressed only by them", () => {
  const m = { myId: "ME", myName: "Alice's Spencer", text: "Echo from Bob: @Alice's Spencer said hi" };
  assert.equal(isAddressed({ ...m, by: "agent", mentions: ["CAROL"] }), false);
  assert.equal(isAddressed({ ...m, by: "agent", mentions: ["ME"] }), true);
  assert.equal(isAddressed({ ...m, by: "agent" }), true);
  assert.equal(isAddressed({ ...m, by: "human", mentions: ["CAROL"] }), true);
});

test("RateLimiter: per-minute and per-hour sliding windows, per channel", () => {
  let now = 1_000_000;
  const rl = new RateLimiter({ perMinute: 2, perHour: 3 }, () => now);
  assert.equal(rl.tryAcquire("a"), true);
  assert.equal(rl.tryAcquire("a"), true);
  assert.equal(rl.tryAcquire("a"), false, "minute window full");
  assert.equal(rl.tryAcquire("b"), true, "other channel unaffected");
  now += 60_001;
  assert.equal(rl.check("a"), true);
  assert.equal(rl.tryAcquire("a"), true);
  assert.equal(rl.tryAcquire("a"), false, "hour window full (3)");
  now += 58 * 60_000;
  assert.equal(rl.tryAcquire("a"), false, "first two hits are 59 min old, still in the hour window");
  now += 60_000;
  assert.equal(rl.tryAcquire("a"), true, "hour window slid");
  rl.record("c");
  rl.record("c");
  assert.equal(rl.check("c"), false);
});

test("RateLimiter reads live limits", () => {
  let limits = { perMinute: 1, perHour: 10 };
  const rl = new RateLimiter(() => limits, () => 0);
  assert.equal(rl.tryAcquire("x"), true);
  assert.equal(rl.tryAcquire("x"), false);
  limits = { perMinute: 5, perHour: 10 };
  assert.equal(rl.tryAcquire("x"), true);
});

test("decideReply: maxHops 0 means no hop cap", () => {
  assert.deepEqual(decideReply({ ...base, maxHops: 0, hop: 10_000 }), { reply: true });
});

test("decideReply: an agent message marked final ends the exchange; final on a human message is ignored", () => {
  assert.deepEqual(decideReply({ ...base, by: "agent", final: true }), { reply: false, note: "conversation ended" });
  assert.deepEqual(decideReply({ ...base, by: "human", final: true }), { reply: true });
  assert.deepEqual(decideReply({ ...base, by: "agent", final: true, autoReply: false }), { reply: false, note: "auto-reply off" });
});

test("loopLimits: per trust level, from the policy defaults", () => {
  assert.deepEqual(loopLimits(DEFAULT_POLICY, "standard"), { maxHops: 8, perMinute: 6, perHour: 60 });
  assert.deepEqual(loopLimits(DEFAULT_POLICY, undefined), { maxHops: 8, perMinute: 6, perHour: 60 });
  assert.deepEqual(loopLimits(DEFAULT_POLICY, "full"), { maxHops: 0, perMinute: 20, perHour: 200 });
});

test("config: loop-guard numbers must be non-negative integers", () => {
  assert.equal(resolveConfig({ policy: { maxHopsFullTrust: 40 } as never }).policy.maxHopsFullTrust, 40);
  assert.equal(resolveConfig({ policy: { maxHops: 4 } as never }).policy.maxHops, 4, "old configs keep working");
  assert.throws(() => resolveConfig({ policy: { maxHops: -1 } as never }), /policy.maxHops/);
  assert.throws(() => resolveConfig({ policy: { repliesPerHourFullTrust: "lots" } as never }), /repliesPerHourFullTrust/);
});

test("parseAgentAnswer: NO_REPLY, empty, and the [END] marker", () => {
  assert.deepEqual(parseAgentAnswer("  "), { send: false });
  assert.deepEqual(parseAgentAnswer(" NO_REPLY\n"), { send: false });
  assert.deepEqual(parseAgentAnswer("[END]"), { send: false });
  assert.deepEqual(parseAgentAnswer("hello"), { send: true, text: "hello", final: false });
  assert.deepEqual(parseAgentAnswer("All done, here it is.\n\n[END]"), { send: true, text: "All done, here it is.", final: true });
  assert.deepEqual(parseAgentAnswer("Bye! [end] "), { send: true, text: "Bye!", final: true });
  assert.deepEqual(parseAgentAnswer("[END] is how I close"), { send: true, text: "[END] is how I close", final: false });
});

test("RateLimiter: reset refills a channel; usage counts; limits may depend on the channel", () => {
  const now = 5_000_000;
  const rl = new RateLimiter((ch) => (ch === "full" ? { perMinute: 3, perHour: 10 } : { perMinute: 1, perHour: 10 }), () => now);
  assert.equal(rl.tryAcquire("std"), true);
  assert.equal(rl.tryAcquire("std"), false);
  assert.deepEqual(rl.usage("std"), { lastMinute: 1, lastHour: 1 });
  rl.reset("std");
  assert.deepEqual(rl.usage("std"), { lastMinute: 0, lastHour: 0 });
  assert.equal(rl.tryAcquire("std"), true);
  for (let i = 0; i < 3; i++) assert.equal(rl.tryAcquire("full"), true);
  assert.equal(rl.tryAcquire("full"), false);
});
