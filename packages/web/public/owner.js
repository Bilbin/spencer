// The owner's own conversation with their Spencer.
import { h, icon, linkify, timeShort, timeFull, autoGrow, selfAvatar } from "./dom.js";
import { api, attempt } from "./api.js";
import { S, on, setOwner } from "./state.js";
import { viewHeader } from "./common.js";
import { scrollKeeper } from "./scroll.js";

const EXAMPLES = ["List my peers", "Ask Bob's Spencer for the logs", "What transfers are waiting for me?", "Create an invite for Carol"];

function ownerItem(item) {
  const time = h("time", { datetime: new Date(item.ts).toISOString(), title: timeFull(item.ts) }, timeShort(item.ts));
  switch (item.role) {
    case "user":
      return h("div.msg-row.mine", null, h("div.bubble.user", null, h("div.bubble-text", null, linkify(item.text)), h("div.bubble-meta", null, time)));
    case "assistant":
      return h(
        "div.msg-row",
        null,
        selfAvatar(),
        h("div.bubble.assistant", null, h("div.bubble-text", null, linkify(item.text)), h("div.bubble-meta", null, time)),
      );
    case "tool": {
      const details = h(
        `details.tool-row${item.isError ? ".error" : ""}`,
        null,
        h(
          "summary",
          null,
          h("span.tool-icon", { "aria-hidden": "true" }, item.isError ? "!" : "⚙"),
          h("span.tool-name", null, item.toolName || "tool"),
          item.isError ? h("span.pill.bad", null, "error") : null,
          h("span.tool-preview", null, item.text.replace(/\s+/g, " ").trim().slice(0, 140)),
        ),
        h("pre.tool-body", null, item.text),
      );
      return h("div.tool-wrap", null, details);
    }
    case "note": {
      const untrusted = item.untrusted === true;
      return h(
        `div.note${untrusted ? ".untrusted" : ""}`,
        { role: "note" },
        h("div.note-label", null, icon(untrusted ? "warn" : "bot", 14), untrusted ? " Untrusted peer content" : " Note", h("span.note-time", null, time)),
        h("div.note-text", null, linkify(item.text)),
      );
    }
    default:
      return h("div.system-line", null, item.text);
  }
}

export function ownerView(main) {
  const transcript = h("div.transcript", { role: "log", "aria-live": "polite", "aria-label": "Conversation with Spencer" });
  const busy = h("div.busy", { hidden: true, role: "status" }, h("span.dots", { "aria-hidden": "true" }, h("i"), h("i"), h("i")), " Spencer is working…");
  const input = h("textarea.composer-input", {
    rows: "1",
    placeholder: "Message Spencer…",
    "aria-label": "Message Spencer",
  });
  const sendBtn = h("button.send-btn", { type: "submit", "aria-label": "Send", title: "Send (Enter)" }, icon("send", 18));
  const form = h("form.composer", null, h("div.composer-box", null, input, sendBtn), h("p.composer-hint", null, "Enter to send · Shift+Enter for a new line"));
  const scroller = h("div.scroller", null, transcript, busy);

  const title = h("div.title-stack", null, h("h1", null, "Spencer"), h("span.subtitle", null, "Your agent · private conversation"));
  main.append(viewHeader([selfAvatar(), title]), scroller, form);

  const keeper = scrollKeeper(scroller);

  const send = async (text) => {
    text = text.trim();
    if (!text) return;
    input.value = "";
    autoGrow(input);
    const res = await attempt(() => api.ownerSend(text));
    if (!res) {
      input.value = text;
      autoGrow(input);
    }
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send(input.value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  input.addEventListener("input", () => autoGrow(input));

  const render = () => {
    keeper.before();
    if (!S.owner) {
      transcript.replaceChildren(h("div.loading", null, "Loading…"));
    } else if (!S.owner.length) {
      transcript.replaceChildren(
        h(
          "div.empty-chat",
          null,
          selfAvatar("big"),
          h("h2", null, "Talk to your Spencer"),
          h("p", null, "Ask it to message your peers, send files, or use its tools."),
          h(
            "div.examples",
            null,
            EXAMPLES.map((ex) => h("button.example", { type: "button", on: { click: () => send(ex) } }, ex)),
          ),
        ),
      );
    } else {
      transcript.replaceChildren(...S.owner.map(ownerItem));
    }
    keeper.after();
  };
  const renderBusy = () => {
    keeper.before();
    busy.hidden = !S.ownerBusy;
    keeper.after();
  };

  render();
  renderBusy();
  if (!S.owner) attempt(() => api.ownerMessages(200)).then((r) => r && setOwner(r.items ?? []));
  requestAnimationFrame(() => {
    keeper.toBottom();
    input.focus();
  });

  const offs = [on("owner", render), on("busy", renderBusy)];
  return { destroy: () => offs.forEach((f) => f()) };
}

