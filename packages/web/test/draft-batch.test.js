import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadDraftBatch } from "../public/draft-batch.js";

const draft = (name) => ({ file: { name }, status: "draft" });

function controls(drafts, upload) {
  return {
    isPresent: (item) => drafts.includes(item),
    upload,
    onSuccess: (item) => { item.status = "sent"; },
    onFailure: (item) => { item.status = "failed"; },
  };
}

test("a Send snapshots its files; removing queued drafts skips them and later drops wait", async () => {
  const active = draft("active.txt");
  const removed = draft("removed.txt");
  const drafts = [active, removed];
  const calls = [];
  let release;
  const pending = uploadDraftBatch(drafts, controls(drafts, async (item) => {
    calls.push(item.file.name);
    if (item === active) await new Promise((resolve) => { release = resolve; });
    return {};
  }));

  drafts.splice(drafts.indexOf(removed), 1);
  const later = draft("later.txt");
  drafts.push(later);
  release();

  assert.equal(await pending, true);
  assert.deepEqual(calls, ["active.txt"]);
  assert.equal(later.status, "draft");
});

test("partial failure retries only unsuccessful files, not successful transfers", async () => {
  const first = draft("first.txt");
  const second = draft("second.txt");
  const drafts = [first, second];
  const calls = [];
  let failSecond = true;
  const upload = async (item) => {
    calls.push(item.file.name);
    if (item === second && failSecond) throw new Error("synthetic failure");
    return {};
  };

  assert.equal(await uploadDraftBatch(drafts, controls(drafts, upload)), false);
  assert.deepEqual(calls, ["first.txt", "second.txt"]);
  failSecond = false;
  assert.equal(await uploadDraftBatch(drafts, controls(drafts, upload)), true);
  assert.deepEqual(calls, ["first.txt", "second.txt", "second.txt"]);
});
