// Upload only the drafts the person explicitly sent. The snapshot prevents drops made during an
// in-flight upload from joining that send; isPresent lets a removed queued draft be skipped.
export async function uploadDraftBatch(drafts, { isPresent, upload, onSuccess, onFailure }) {
  const batch = drafts.filter((draft) => draft.status !== "sent");
  for (const draft of batch) {
    if (!isPresent(draft) || draft.status === "sent") continue;
    try {
      const transfer = await upload(draft);
      onSuccess(draft, transfer);
    } catch (error) {
      onFailure(draft, error);
      return false;
    }
  }
  return true;
}
