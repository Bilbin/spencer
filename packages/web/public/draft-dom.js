import { h } from "./dom.js";

export function createDraftRecipientSelect(members, formatMember) {
  return h(
    "select.draft-recipient.input",
    { "aria-label": "Choose who gets the attached files" },
    h("option", { value: "" }, "Choose a member…"),
    members.map((member) => h("option", { value: member.id }, formatMember(member))),
  );
}

export function createDraftRemoveButton(draft, onRemove) {
  return h("button.draft-remove", {
    type: "button",
    "aria-label": `Remove ${draft.file.name}`,
    disabled: draft.status === "uploading",
    on: { click: onRemove },
  }, "×");
}

export function refreshDraftRecipientOptions(select, state, members, formatMember) {
  if (!select) return;
  const selected = state.recipient ?? select.value;
  select.replaceChildren(
    h("option", { value: "" }, "Choose a member…"),
    ...members.map((member) => h("option", { value: member.id }, formatMember(member))),
  );
  const stillValid = members.some((member) => member.id === selected);
  select.value = stillValid ? selected : "";
  if (!stillValid && !state.recipientLocked) state.recipient = null;
  select.disabled = state.recipientLocked;
}

export function scrollAfterAcceptedFile(scrollers, messageText) {
  if (!messageText) [...scrollers].at(-1)?.();
}
