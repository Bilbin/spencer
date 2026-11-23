export function hasDraftFile(drafts, file) {
  return drafts.some((draft) => draft.file === file);
}

// Upload only the drafts the person explicitly sent. The snapshot prevents drops made during an
// in-flight upload from joining that send; isPresent lets a removed queued draft be skipped.
export async function uploadDraftBatch(drafts, { isPresent, upload, onQueued, onSuccess, onFailure }) {
  const batch = drafts.filter((draft) => draft.status !== "sent" && draft.status !== "uploading" && draft.status !== "queued");
  for (const draft of batch) {
    draft.status = "queued";
    onQueued?.(draft);
  }
  for (const draft of batch) {
    if (!isPresent(draft) || draft.status !== "queued") continue;
    draft.status = "uploading";
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
