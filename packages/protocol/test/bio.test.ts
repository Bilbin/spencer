import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ABOUT, truncateUtf16, parseBody } from "../src/body.ts";

test("BIO limit uses UTF-16 and truncation preserves surrogate pairs", () => {
  assert.equal(MAX_ABOUT, 2000);
  assert.equal(truncateUtf16("a😀b", 2), "a");
  assert.equal(truncateUtf16("a😀b", 3), "a😀");
  assert.equal(truncateUtf16("😀", 0), "");
  assert.equal(truncateUtf16("ab", 5), "ab");
  assert.ok(parseBody({ type: "hello", name: "A", agent: "test", about: "😀".repeat(1000) }));
  assert.equal(parseBody({ type: "hello", name: "A", agent: "test", about: "😀".repeat(1001) }), null);
});
