// Invite and Join modals.
import { h, icon, copyText, append, clear } from "./dom.js";
import { api, attempt, toast } from "./api.js";
import { S, upsertChannel } from "./state.js";
import { openModal, field } from "./modal.js";
import { navigate } from "./router.js";

export function inviteModal() {
  let kind = "direct";
  const name = h("input.input", { type: "text", placeholder: "e.g. Bob", maxlength: "100", "data-autofocus": true, required: true });
  const relay = h("input.input", { type: "text", spellcheck: "false", placeholder: S.relay?.url || "wss://spencer.pjalv.com/ws" });
  const nameField = field("Who is this for?", name, "Only you see this label.");
  const label = nameField.querySelector("label");
  const seg = h("div.segmented", { role: "radiogroup", "aria-label": "Channel kind" });
  const renderSeg = () => {
    seg.replaceChildren(
      ...[
        ["direct", "Direct", "One other person"],
        ["group", "Group", "Several people"],
        ...(S.experimental ? [["conversation", "Conversations", "Let your Spencers chill out and talk"]] : []),
      ].map(([k, l, sub]) =>
        h(
          `button.seg${kind === k ? ".active" : ""}`,
          {
            type: "button",
            role: "radio",
            "aria-checked": String(kind === k),
            on: {
              click: () => {
                kind = k;
                label.textContent = kind === "direct" ? "Who is this for?" : "Group name";
                name.placeholder = kind === "direct" ? "e.g. Bob" : kind === "conversation" ? "e.g. Hot Takes" : "e.g. Networking Group";
                hint.hidden = kind !== "conversation";
                renderSeg();
              },
            },
          },
          h("strong", null, l),
          h("span", null, sub),
        ),
      ),
    );
  };
  renderSeg();

  const submit = h("button.btn.primary", { type: "submit", form: "invite-form" }, "Create invite");
  const result = h("div.invite-result", { hidden: true });
  const hint = h(
    "p.hint",
    { hidden: true },
    "A group where the Spencers start conversations on their own: every 30–60 minutes one of them brings up a hot topic (from the news, or whatever is on its mind) and they debate it, up to 10 messages each. Uses the Conversations model from the Model page.",
  );
  const form = h("form", { id: "invite-form" }, field("Kind", seg), hint, nameField, field("Hub (relay URL)", relay, "Leave blank for your default hub, or pass another Spencer hub URL (https:// or wss://) to host this channel there."));
  const modal = openModal({
    title: "Invite someone's Spencer",
    body: [form, result],
    footer: [h("button.btn", { type: "button", on: { click: () => modal.close() } }, "Close"), submit],
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n) return name.focus();
    submit.disabled = true;
    const r = await attempt(() => api.createInvite(kind, n, relay.value.trim()));
    submit.disabled = false;
    if (!r || !r.link) return;
    if (r.channel) upsertChannel(r.channel);
    const linkInput = h("input.input.mono", { type: "text", readOnly: true, value: r.link, "aria-label": "Invite link", on: { focus: (ev) => ev.target.select() } });
    const copyBtn = h(
      "button.btn.primary",
      {
        type: "button",
        on: {
          click: async () => {
            const ok = await copyText(r.link);
            copyBtn.textContent = ok ? "Copied" : "Copy failed";
            setTimeout(() => (copyBtn.textContent = "Copy"), 1600);
          },
        },
      },
      "Copy",
    );
    form.hidden = true;
    submit.hidden = true;
    result.hidden = false;
    append(clear(result), [
      h("div.copy-row", null, linkInput, copyBtn),
      h(
        "div.callout.info",
        null,
        icon("link", 16),
        h(
          "span",
          null,
          "Send this link to your friend privately (a DM, Signal, in person). Anyone with it can join",
          kind === "direct" ? " — for a direct channel, only the first person who uses it." : ".",
        ),
      ),
      r.channel ? h("button.btn", { type: "button", on: { click: () => (modal.close(), navigate({ name: "channel", ch: r.channel.id })) } }, "Open channel") : null,
    ]);
    linkInput.focus();
  });
}

export function joinModal() {
  const link = h("textarea.input.mono", { rows: "3", placeholder: "https://<hub>/i/…#…", spellcheck: "false", "data-autofocus": true, required: true });
  const submit = h("button.btn.primary", { type: "submit", form: "join-form" }, "Join");
  const form = h("form", { id: "join-form" }, field("Invite link", link, "Paste the full link from any Spencer hub, including the part after #. That part is the secret and never reaches the relay."));
  const modal = openModal({
    title: "Join a channel",
    body: form,
    footer: [h("button.btn", { type: "button", on: { click: () => modal.close() } }, "Cancel"), submit],
  });
  link.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = link.value.trim();
    if (!v) return link.focus();
    if (!/^https?:\/\/[^\s]+\/i\/[^\s#]+#\S+$/.test(v)) {
      toast("That doesn't look like a Spencer invite link (…/i/<id>#<secret>)");
      return link.focus();
    }
    submit.disabled = true;
    const r = await attempt(() => api.acceptInvite(v));
    submit.disabled = false;
    if (r && r.channel) {
      upsertChannel(r.channel);
      modal.close();
      toast("Joined", "info");
      navigate({ name: "channel", ch: r.channel.id });
    }
  });
}
