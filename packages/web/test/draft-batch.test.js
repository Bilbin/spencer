import { test } from "node:test";
import assert from "node:assert/strict";
import { draftFileError, hasDraftFile, uploadDraftBatch } from "../public/draft-batch.js";
import { clearSentDraftsWhenNoWork, discardEmptyChannelDraftState, getChannelDraftState, isUploadOutcomeUnknown, markUploadFailure, releaseRecipientAfterDefiniteFailure, removeDraft, resolveUploadSuccess, selectDraftRecipient } from "../public/draft-state.js";

const draft = (name, file = { name }) => ({ file, status: "draft" });

test("channel state survives navigation while text or a send is pending", () => {
  const states = new Map();
  const original = getChannelDraftState(states, "channel-a");
  original.messageText = "unsent text";
  discardEmptyChannelDraftState(states, "channel-a", original);
  assert.equal(getChannelDraftState(states, "channel-a"), original);

  original.messageText = "message with attachment";
  original.sending = true;
  original.drafts.push(draft("file.txt"));
  original.drafts.length = 0; // Upload completed; the message request is still pending.
  discardEmptyChannelDraftState(states, "channel-a", original);
  assert.equal(getChannelDraftState(states, "channel-a"), original);
  assert.equal(original.sending, true);

  original.sending = false;
  original.messageText = ""; // Message send succeeded.
  discardEmptyChannelDraftState(states, "channel-a", original);
  assert.equal(states.has("channel-a"), false);
});

test("upload failures distinguish definite client rejection from ambiguous outcomes", () => {
  assert.equal(isUploadOutcomeUnknown({ status: 400 }), false);
  assert.equal(isUploadOutcomeUnknown({ status: 499 }), false);
  assert.equal(isUploadOutcomeUnknown({ status: 409 }), true, "an upload-id conflict can indicate an earlier accepted send");
  assert.equal(isUploadOutcomeUnknown({ status: 0 }), true);
  assert.equal(isUploadOutcomeUnknown({ status: 503 }), true);
  assert.equal(isUploadOutcomeUnknown(new Error("unknown transport failure")), true);
});

test("removing the last unsent file clears completed drafts and recipient state", () => {
  const state = getChannelDraftState(new Map(), "channel-a");
  state.recipient = "member-a";
  state.recipientLocked = true;
  state.drafts.push({ ...draft("sent.txt"), status: "sent" });
  assert.equal(clearSentDraftsWhenNoWork(state), true);
  assert.deepEqual(state.drafts, []);
  assert.equal(state.recipient, null);
  assert.equal(state.recipientLocked, false);
  assert.equal(clearSentDraftsWhenNoWork(state), true, "empty drafts also remain cleared");
});

test("a definite first-upload failure allows a recipient change with a fresh retry id", () => {
  const state = getChannelDraftState(new Map(), "channel-a");
  const item = { ...draft("file.txt"), uploadId: "initial-id", outcomeUnknown: false };
  state.drafts.push(item);
  state.recipient = "member-a";
  state.recipientLocked = true;
  assert.equal(releaseRecipientAfterDefiniteFailure(state), true);
  assert.equal(selectDraftRecipient(state, "member-b", () => "new-id"), true);
  assert.equal(item.uploadId, "new-id");
  assert.equal(state.recipient, "member-b");
});

test("dismissing an ambiguous draft keeps the lock until its send attempt has settled", () => {
  const state = getChannelDraftState(new Map(), "channel-a");
  const uncertain = { ...draft("possibly-sent.txt"), status: "failed", uploadId: "stable-id", outcomeUnknown: true };
  state.drafts.push(uncertain);
  state.recipient = "member-a";
  state.recipientLocked = true;
  state.sending = true;

  assert.equal(removeDraft(state, uncertain), true);
  assert.deepEqual(state.drafts, []);
  assert.equal(state.recipientLocked, true);
  assert.equal(releaseRecipientAfterDefiniteFailure(state), false);

  state.sending = false;
  clearSentDraftsWhenNoWork(state);
  assert.equal(releaseRecipientAfterDefiniteFailure(state), true);
  assert.equal(state.recipient, null);
  assert.equal(state.recipientLocked, false);
});

test("dismissing one uncertain draft cannot unlock another uncertain, accepted, or in-flight draft", () => {
  const state = getChannelDraftState(new Map(), "channel-a");
  const removed = { ...draft("dismissed.txt"), status: "failed", outcomeUnknown: true };
  const remaining = { ...draft("still-uncertain.txt"), status: "failed", outcomeUnknown: true };
  state.drafts.push(removed, remaining);
  state.recipientLocked = true;

  assert.equal(removeDraft(state, removed), true);
  assert.equal(releaseRecipientAfterDefiniteFailure(state), false);
  remaining.outcomeUnknown = false;
  remaining.status = "uploading";
  assert.equal(releaseRecipientAfterDefiniteFailure(state), false);
  remaining.status = "sent";
  assert.equal(releaseRecipientAfterDefiniteFailure(state), false);
});

test("a later rejected retry cannot erase an earlier ambiguous outcome", () => {
  const state = getChannelDraftState(new Map(), "channel-a");
  const item = { ...draft("file.txt"), uploadId: "stable-id" };
  state.drafts.push(item);
  state.recipient = "member-a";
  state.recipientLocked = true;
  markUploadFailure(item, { status: 0 });
  markUploadFailure(item, { status: 429 });
  assert.equal(item.outcomeUnknown, true);
  assert.equal(releaseRecipientAfterDefiniteFailure(state), false);
  assert.equal(selectDraftRecipient(state, "member-b", () => "must-not-be-used"), false);
  assert.equal(item.uploadId, "stable-id");
});

test("a successful idempotent retry resolves the prior ambiguity", () => {
  const item = { ...draft("file.txt"), outcomeUnknown: true };
  resolveUploadSuccess(item);
  assert.equal(item.outcomeUnknown, false);
});

test("an ambiguous upload outcome keeps recipient and retry id fixed", () => {
  const state = getChannelDraftState(new Map(), "channel-a");
  const item = { ...draft("file.txt"), uploadId: "stable-id", outcomeUnknown: true };
  state.drafts.push(item);
  state.recipient = "member-a";
  state.recipientLocked = true;
  assert.equal(releaseRecipientAfterDefiniteFailure(state), false);
  assert.equal(selectDraftRecipient(state, "member-b", () => "must-not-be-used"), false);
  assert.equal(selectDraftRecipient(state, "member-a", () => "must-not-be-used"), false);
  assert.equal(item.uploadId, "stable-id");
  assert.equal(state.recipient, "member-a");
});

test("a matching recipient retry preserves its id, while changing recipient rotates it", () => {
  const state = getChannelDraftState(new Map(), "channel-a");
  const item = { ...draft("file.txt"), uploadId: "stable-id" };
  state.drafts.push(item);
  state.recipient = "member-a";
  selectDraftRecipient(state, "member-a", () => "unused-id");
  assert.equal(item.uploadId, "stable-id");
  selectDraftRecipient(state, "member-b", () => "fresh-id");
  assert.equal(item.uploadId, "fresh-id");
});

test("invalid names and oversize files get distinct validation feedback", () => {
  assert.equal(draftFileError({ name: "", size: 1 }, 100), "File name must not be empty");
  assert.equal(draftFileError({ name: "   ", size: 1 }, 100), "File name must not be empty");
  assert.equal(draftFileError({ name: "large.bin", size: 101 }, 100), "large.bin exceeds the upload size limit");
  assert.equal(draftFileError({ name: "notes.txt", size: 1 }, 100), null);
});

test("distinct same-metadata files are not silently collapsed", () => {
  const firstFile = { name: "report.txt", size: 12, lastModified: 1 };
  const otherFile = { name: "report.txt", size: 12, lastModified: 1 };
  const drafts = [draft("report.txt", firstFile)];
  assert.equal(hasDraftFile(drafts, firstFile), true);
  assert.equal(hasDraftFile(drafts, otherFile), false);
});

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

test("a second view cannot upload files already reserved by an in-flight Send", async () => {
  const first = draft("first.txt");
  const second = draft("second.txt");
  const drafts = [first, second];
  const calls = [];
  let release;
  const upload = async (item) => {
    calls.push(item.file.name);
    if (item === first) await new Promise((resolve) => { release = resolve; });
    return {};
  };

  const initialSend = uploadDraftBatch(drafts, controls(drafts, upload));
  assert.equal(first.status, "uploading");
  assert.equal(second.status, "queued");
  assert.equal(await uploadDraftBatch(drafts, controls(drafts, upload)), true);
  assert.deepEqual(calls, ["first.txt"]);
  release();
  assert.equal(await initialSend, true);
  assert.deepEqual(calls, ["first.txt", "second.txt"]);
});

test("partial failure retries only unsuccessful files, not successful transfers", async () => {
  const first = draft("first.txt");
  const second = draft("second.txt");
  const third = draft("third.txt");
  const drafts = [first, second, third];
  const calls = [];
  let failSecond = true;
  const upload = async (item) => {
    calls.push(item.file.name);
    if (item === second && failSecond) throw new Error("synthetic failure");
    return {};
  };

  assert.equal(await uploadDraftBatch(drafts, controls(drafts, upload)), false);
  assert.deepEqual(calls, ["first.txt", "second.txt"]);
  assert.deepEqual(drafts.map((item) => item.status), ["sent", "failed", "draft"]);
  failSecond = false;
  assert.equal(await uploadDraftBatch(drafts, controls(drafts, upload)), true);
  assert.deepEqual(calls, ["first.txt", "second.txt", "second.txt", "third.txt"]);
});
