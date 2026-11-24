export function draftFileError(file, maxBytes, maxNameBytes = 255) {
  if (!file.name?.trim()) return "File name must not be empty";
  if (file.size > maxBytes) return `${file.name} exceeds the upload size limit`;
  if (new TextEncoder().encode(file.name).length > maxNameBytes) return "File names must be 255 bytes or shorter";
  return null;
}

export function hasDraftFile(drafts, file) {
  return drafts.some((draft) => draft.file === file);
}

// Upload only the drafts the person explicitly sent. The snapshot prevents drops made during an
// in-flight upload from joining that send; isPresent lets a removed queued draft be skipped.
export async function uploadDraftBatch(drafts, { isPresent, upload, onUpdate, onSuccess, onFailure }) {
  const batch = drafts.filter((draft) => draft.status !== "sent" && draft.status !== "uploading" && draft.status !== "queued");
  for (const draft of batch) {
    draft.status = "queued";
    onUpdate?.(draft);
  }
  for (const draft of batch) {
    if (!isPresent(draft) || draft.status !== "queued") continue;
    draft.status = "uploading";
    try {
      const transfer = await upload(draft);
      onSuccess(draft, transfer);
    } catch (error) {
      onFailure(draft, error);
      for (const pending of batch) {
        if (pending.status !== "queued") continue;
        pending.status = "draft";
        onUpdate?.(pending);
      }
      return false;
    }
  }
  return true;
}
