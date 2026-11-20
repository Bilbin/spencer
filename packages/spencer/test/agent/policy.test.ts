import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { decideReply, isAddressed, isRepeat, loopLimits, nameHandles, parseAgentAnswer, textMentions } from "../../src/policy.ts";
import { TurnBudget } from "../../src/agent/budget.ts";
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



test("decideReply: maxHops 0 means no hop cap", () => {
  assert.deepEqual(decideReply({ ...base, maxHops: 0, hop: 10_000 }), { reply: true });
});

test("decideReply: an agent message marked final ends the exchange; final on a human message is ignored", () => {
  assert.deepEqual(decideReply({ ...base, by: "agent", final: true }), { reply: false, note: "conversation ended" });
  assert.deepEqual(decideReply({ ...base, by: "human", final: true }), { reply: true });
  assert.deepEqual(decideReply({ ...base, by: "agent", final: true, autoReply: false }), { reply: false, note: "auto-reply off" });
});

test("loopLimits: per trust level, from the policy defaults", () => {
  const std = { maxHops: 40, maxTurns: 20, perMinute: 6, perHour: 60, perDay: 300 };
  assert.deepEqual(loopLimits(DEFAULT_POLICY, "standard"), std);
  assert.deepEqual(loopLimits(DEFAULT_POLICY, undefined), std);
  assert.deepEqual(loopLimits(DEFAULT_POLICY, "full"), { maxHops: 0, maxTurns: 50, perMinute: 20, perHour: 200, perDay: 1000 });
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

test("TurnBudget: streak, minute/hour/day windows, resets, and it survives a reopen", () => {
  const db = new DatabaseSync(":memory:");
  let now = 10_000_000;
  const limits = { maxTurns: 3, perMinute: 2, perHour: 4, perDay: 5 };
  let b = new TurnBudget(db, () => now);
  b.init();
  assert.deepEqual(b.check("c", limits), { ok: true });
  b.record("c");
  b.record("c");
  const minute = b.check("c", limits);
  assert.equal(minute.ok, false);
  assert.equal(!minute.ok && minute.why, "rate limited", "per-minute burst: skip, don't pause");
  assert.deepEqual(b.check("other", limits), { ok: true }, "per channel");
  now += 61_000;
  assert.deepEqual(b.check("c", limits), { ok: true });
  b.record("c");
  const streak = b.check("c", limits);
  assert.equal(!streak.ok && streak.why, "budget exhausted");
  assert.match(!streak.ok ? streak.detail : "", /3 automatic replies in a row/);

  // A person writing resets the streak but not the rate windows.
  b.humanSpoke("c");
  assert.equal(b.usage("c").streak, 0);
  assert.equal(b.usage("c").lastHour, 3);
  b.record("c");
  now += 61_000;
  const hour = b.check("c", limits);
  assert.equal(!hour.ok && hour.why, "budget exhausted");
  assert.match(!hour.ok ? hour.detail : "", /in the last hour/);

  // Persistent: a new instance on the same database sees the same budget (a restart does not refill it).
  b = new TurnBudget(db, () => now);
  b.init();
  assert.equal(b.usage("c").lastHour, 4);
  assert.equal(b.check("c", limits).ok, false);

  // The owner refills everything.
  now += 1;
  b.ownerReset("c");
  assert.deepEqual(b.usage("c"), { streak: 0, lastMinute: 0, lastHour: 0, lastDay: 0 });
  assert.deepEqual(b.check("c", limits), { ok: true });

  // The daily window.
  for (let i = 0; i < 5; i++) {
    now += 20 * 60_000;
    b.humanSpoke("c");
    b.record("c");
  }
  now += HOUR_PLUS;
  const day = b.check("c", limits);
  assert.match(!day.ok ? day.detail : "", /today/);
  db.close();
});

const HOUR_PLUS = 3_600_001;

test("isRepeat: same words, or near-identical long texts; short different acks are not repeats", () => {
  assert.equal(isRepeat("Thanks, all good!", ["thanks all good"]), true);
  assert.equal(isRepeat("Thanks!", ["Thank you!"]), false);
  assert.equal(isRepeat("anything", []), false);
  const long = "The build finished on commit abc123 and all 113 tests passed on the CI runner today";
  assert.equal(isRepeat(long + ".", [long]), true);
  assert.equal(isRepeat(long.replace("today", "this morning"), [long]), false, "a real change is not a repeat");
  assert.equal(isRepeat("Echo from Alice: Echo from Bob: hi there friend of mine ok", ["Echo from Alice: hi there friend of mine ok"]), false);
  // Text that repeats a phrase is not its shorter self (count-based, not set-based, overlap).
  const nested = (n: number) => "Echo from Alice: Echo from Bob: ".repeat(n) + "let's work through this together";
  assert.equal(isRepeat(nested(2), [nested(1)]), false);
});
