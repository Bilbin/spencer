// Quick switcher (Ctrl/⌘ K) and the keyboard shortcuts sheet.
import { h, icon, avatar, selfAvatar } from "./dom.js";
import { S, channelTitle, peers, unreadCount, attentionCount, workingIn } from "./state.js";
import { openModal } from "./modal.js";
import { navigate } from "./router.js";

function destinations() {
  const channels = [...S.channels.values()].sort((a, b) => a.createdAt - b.createdAt);
  const n = attentionCount();
  return [
    { label: "Needs you", sub: n ? `${n} waiting` : "nothing waiting", view: { name: "inbox" }, mark: () => h("span.switch-icon", null, icon("inbox", 16)) },
    { label: "Spencer", sub: S.ownerBusy ? "working" : "your agent", view: { name: "owner" }, mark: () => selfAvatar("sm") },
    ...channels.map((c) => {
      const title = channelTitle(c);
      const unread = unreadCount(c.id);
      const busy = workingIn(c.id).length > 0;
      return {
        label: title,
        sub: [c.kind === "group" ? "group" : c.name && c.name !== title ? c.name : "direct", busy ? "working" : null, unread ? `${unread} unread` : null].filter(Boolean).join(", "),
        view: { name: "channel", ch: c.id },
        mark: () => (c.kind === "group" ? h("span.avatar.agent.group.sm", { "aria-hidden": "true" }, icon("users", 13)) : avatar(title, peers(c)[0]?.id ?? c.id, "sm")),
      };
    }),
    { label: "Transfers", sub: "files sent and received", view: { name: "transfers" }, mark: () => h("span.switch-icon", null, icon("transfer", 16)) },
    { label: "MCP servers", sub: "tools your Spencer can call", view: { name: "mcp" }, mark: () => h("span.switch-icon", null, icon("plug", 16)) },
    { label: "Soul", sub: "your Spencer's personality (SOUL.md)", view: { name: "soul" }, mark: () => h("span.switch-icon", null, icon("heart", 16)) },
    { label: "Model", sub: "what your Spencer thinks with, GitHub Copilot sign-in", view: { name: "model" }, mark: () => h("span.switch-icon", null, icon("spark", 16)) },
  ];
}

export function openSwitcher() {
  const all = destinations();
  let shown = all;
  let idx = 0;
  const input = h("input.input.switch-input", { type: "text", placeholder: "Jump to a conversation…", "aria-label": "Jump to", role: "combobox", "aria-expanded": "true", "aria-controls": "switch-list", autocomplete: "off", spellcheck: "false", "data-autofocus": true });
  const list = h("ul.switch-list", { id: "switch-list", role: "listbox" });
  let modal;
  const go = (d) => {
    modal.close();
    navigate(d.view);
  };
  const render = () => {
    list.replaceChildren(
      ...(shown.length
        ? shown.map((d, i) =>
            h(
              `li.switch-opt${i === idx ? ".active" : ""}`,
              { role: "option", id: `sw-${i}`, "aria-selected": String(i === idx), on: { mousedown: (e) => (e.preventDefault(), go(d)), mousemove: () => i !== idx && ((idx = i), render()) } },
              d.mark(),
              h("span.switch-label", null, d.label),
              h("span.switch-sub", null, d.sub),
            ),
          )
        : [h("li.switch-none", null, "No conversation matches.")]),
    );
    if (shown.length) input.setAttribute("aria-activedescendant", `sw-${idx}`);
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    shown = q ? all.filter((d) => `${d.label} ${d.sub}`.toLowerCase().includes(q)) : all;
    idx = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      idx = (idx + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[idx]) go(shown[idx]);
    }
  });
  render();
  modal = openModal({ title: "Jump to", body: [input, list], cls: "switcher" });
}

const SHORTCUTS = [
  [["Ctrl", "K"], "Jump to a conversation"],
  [["Alt", "↑"], "Previous conversation"],
  [["Alt", "↓"], "Next conversation"],
  [["/"], "Write a message"],
  [["Enter"], "Send"],
  [["Shift", "Enter"], "New line"],
  [["Esc"], "Close a dialog or panel"],
  [["?"], "Show this list"],
];

export function shortcutsModal() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform ?? "");
  openModal({
    title: "Keyboard shortcuts",
    body: h(
      "dl.shortcuts",
      null,
      SHORTCUTS.map(([keys, what]) => h("div.shortcut", null, h("dt", null, keys.map((k) => h("kbd", null, mac && k === "Ctrl" ? "⌘" : mac && k === "Alt" ? "⌥" : k))), h("dd", null, what))),
    ),
  });
}
