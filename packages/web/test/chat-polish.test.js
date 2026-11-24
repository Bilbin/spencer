import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { inviteLinks, suppressQuietNotice } from "../public/chat-polish.js";

test("activity renders a text separator between server and tool", async () => {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  const interval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  const { activityNode } = await import("../public/common.js");
  globalThis.setInterval = interval;
  assert.equal(activityNode("Using t3code · t3 thread read").textContent, "t3code · t3 thread read");
});

test("consecutive sender notices collapse only for the same reason", () => {
  const m = { from: "a", note: "not addressed" };
  assert.equal(suppressQuietNotice(m, { ...m }), true);
  assert.equal(suppressQuietNotice(m, { ...m, note: "hop cap" }), false);
  assert.equal(suppressQuietNotice(m, { ...m, from: "b" }), false);
});

test("invite detection accepts valid links and rejects unrelated or unsafe URLs", () => {
  const link = `https://example.com/i/${"a".repeat(22)}#${"b".repeat(43)}`;
  assert.deepEqual(inviteLinks(`Join ${link}. ${link}`), [link]);
  assert.deepEqual(inviteLinks("https://example.com/i/no#secret https://user:pass@example.com/i/" + "a".repeat(22) + "#" + "b".repeat(43)), []);
});
