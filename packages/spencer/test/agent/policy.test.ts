import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, decideReply, isAddressed, nameHandles, textMentions } from "../../src/policy.ts";

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
