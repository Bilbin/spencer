export function getChannelDraftState(states, channelId) {
  let state = states.get(channelId);
  if (!state) {
    state = { drafts: [], recipient: null, recipientLocked: false, messageText: "", sending: false, renderers: new Set(), scrollers: new Set() };
    states.set(channelId, state);
  }
  return state;
}

export function isUploadOutcomeUnknown(error) {
  const status = Number(error?.status);
  return status === 409 || !(status >= 400 && status < 500);
}

export function markUploadFailure(draft, error) {
  draft.outcomeUnknown = !!draft.outcomeUnknown || isUploadOutcomeUnknown(error);
}

export function resolveUploadSuccess(draft) {
  draft.outcomeUnknown = false;
}

export function clearSentDraftsWhenNoWork(state) {
  if (state.drafts.some((draft) => draft.status !== "sent")) return false;
  state.drafts.splice(0, state.drafts.length);
  state.recipient = null;
  state.recipientLocked = false;
  return true;
}

export function releaseRecipientAfterDefiniteFailure(state) {
  if (state.drafts.some((draft) => draft.status === "sent" || draft.outcomeUnknown)) return false;
  state.recipientLocked = false;
  return true;
}

export function selectDraftRecipient(state, recipient, newUploadId) {
  if (state.recipientLocked) return false;
  if (recipient !== state.recipient) {
    for (const draft of state.drafts) {
      if (draft.status !== "sent") draft.uploadId = newUploadId();
      draft.outcomeUnknown = false;
      draft.attemptRecipient = undefined;
    }
    state.recipient = recipient;
  }
  return true;
}

export function discardEmptyChannelDraftState(states, channelId, state) {
  if (states.get(channelId) !== state) return;
  if (!state.drafts.length && !state.renderers.size && !state.messageText && !state.sending) states.delete(channelId);
}
