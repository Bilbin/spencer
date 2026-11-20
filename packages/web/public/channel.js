// A channel (direct or group): the bot-to-bot transcript, composer, files and settings.
import { h, icon, iconButton, richText, shortFp, timeShort, timeFull, autoGrow, avatar, clear, append } from "./dom.js";
import { api, attempt, toast } from "./api.js";
import { S, on, setMessages, upsertTransfer, upsertChannel, removeChannel, markRead, peers, channelTitle, allMcpTools, workingIn } from "./state.js";
import { markdown } from "./md.js";
import { viewHeader } from "./common.js";
import { transferCard } from "./transfers.js";
import { openModal, field } from "./modal.js";
import { scrollKeeper } from "./scroll.js";
import { navigate } from "./router.js";

const NOTE_LABEL = {
  "not addressed": "not addressed — no auto-reply",
  "hop cap": "hop cap reached — no auto-reply",
  "rate limited": "rate limited — no auto-reply",
  "auto-reply off": "auto-reply off",
};

// ---------------------------------------------------------------- message rendering

function senderInfo(c, m) {
  if (m.mine) return { name: S.me?.name ?? "You", fp: S.me?.fingerprint, id: S.me?.id ?? m.from };
  const mem = c.members.find((x) => x.id === m.from);
  return { name: m.fromName || mem?.name || `${m.from.slice(0, 8)}…`, fp: mem?.fingerprint, id: m.from };
}

function quoteFor(c, m, byId) {
  if (!m.replyTo) return null;
  const target = byId.get(m.replyTo);
  if (!target) return h("div.quote.missing", null, "↩ in reply to an earlier message");
  const who = target.mine && target.by === "human" ? "You" : senderInfo(c, target).name;
  const text = (target.text ?? target.type).replace(/\s+/g, " ");
  return h(
    "button.quote",
    {
      type: "button",
      title: "Jump to the replied message",
      on: {
        click: () => {
          const el = document.getElementById(`m-${target.id}`);
          if (!el) return;
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          el.classList.add("flash");
          setTimeout(() => el.classList.remove("flash"), 1200);
        },
      },
    },
    h("span.quote-who", null, who),
    h("span.quote-text", null, text.length > 140 ? `${text.slice(0, 140)}…` : text),
  );
}

function statusMark(m) {
  if (!m.mine) return null;
  if (m.status === "failed") return h("span.status.failed", { title: m.note ? `Not delivered: ${m.note}` : "Not delivered", "aria-label": "failed" }, icon("warn", 13), " not delivered");
  if (m.status === "pending") return h("span.status.pending", { title: "Queued — not yet accepted by the relay", "aria-label": "pending" }, icon("clock", 13));
  return h("span.status.sent", { title: "Delivered to the relay", "aria-label": "sent" }, icon("check", 13));
}

function messageRow(c, m, byId, names, myNames) {
  const who = senderInfo(c, m);
  if (m.type === "hello") {
    return h(
      "div.system-line",
      { id: `m-${m.id}` },
      h("span", null, `${who.name} said hello`),
      who.fp ? h("code.fp", { title: `${who.fp}\n${who.id}` }, shortFp(who.fp)) : null,
      m.text ? h("span.system-extra", null, ` — “${m.text}”`) : null,
      h("time", { title: timeFull(m.ts) }, ` · ${timeShort(m.ts)}`),
    );
  }
  if (m.type !== "chat") {
    return h("div.system-line", { id: `m-${m.id}` }, `${who.name} · ${m.type}${m.text ? `: ${m.text}` : ""}`, h("time", { title: timeFull(m.ts) }, ` · ${timeShort(m.ts)}`));
  }
  const by = m.by ?? (m.mine ? "human" : "agent");
  const head = h(
    "div.msg-head",
    null,
    h("span.sender", null, m.mine && by === "human" ? "You" : who.name),
    who.fp ? h("code.fp", { title: `Fingerprint ${who.fp}\nid ${who.id}` }, shortFp(who.fp)) : null,
    h(`span.badge.${by}`, { title: by === "agent" ? "Written by a Spencer's model" : "Typed by a person" }, by),
    m.hop > 0 ? h("span.badge.hop", { title: "Automatic reply depth" }, `hop ${m.hop}`) : null,
    h("time", { datetime: new Date(m.ts).toISOString(), title: timeFull(m.ts) }, timeShort(m.ts)),
    statusMark(m),
  );
  let note = null;
  if (!m.mine && m.note) note = h("div.note-chip", { title: "Why your Spencer did not reply" }, NOTE_LABEL[m.note] ?? m.note);
  else if (m.mine && m.status === "failed") note = h("div.note-chip.failed", null, `The relay rejected this message${m.note ? `: ${m.note}` : ""}. It won't be retried.`);
  return h(
    `div.msg-row${m.mine ? ".mine" : ""}`,
    { id: `m-${m.id}` },
    m.mine ? null : avatar(who.name, who.id),
    h(
      "div.msg-col",
      null,
      head,
      h(`div.bubble.chat${m.mine ? ".mine" : ""}${by === "agent" ? ".agent" : ""}`, null, quoteFor(c, m, byId), h("div.bubble-text.md", null, markdown(m.text ?? "", (s) => richText(s, names, myNames)))),
      note,
    ),
  );
}

// ---------------------------------------------------------------- mention completion

function mentionCompleter(input, getChannel) {
  const list = h("ul.mention-list", { role: "listbox", hidden: true, "aria-label": "Mention a member" });
  let state = null; // {start, items, idx}

  const close = () => {
    state = null;
    list.hidden = true;
    input.removeAttribute("aria-activedescendant");
  };

  const pick = (i) => {
    if (!state) return;
    const m = state.items[i];
    const caret = input.selectionStart;
    const before = input.value.slice(0, state.start);
    const after = input.value.slice(caret);
    const ins = `@${m.name} `;
    input.value = before + ins + after;
    const pos = before.length + ins.length;
    input.setSelectionRange(pos, pos);
    close();
    autoGrow(input);
    input.focus();
  };

  const render = () => {
    clear(list);
    state.items.forEach((m, i) => {
      const li = h(
        `li.mention-opt${i === state.idx ? ".active" : ""}`,
        { role: "option", id: `mopt-${i}`, "aria-selected": String(i === state.idx), on: { mousedown: (e) => (e.preventDefault(), pick(i)) } },
        avatar(m.name, m.id, "xs"),
        h("span", null, m.name),
        h("code.fp", null, shortFp(m.fingerprint)),
      );
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute("aria-activedescendant", `mopt-${state.idx}`);
  };

  const update = () => {
    const c = getChannel();
    const caret = input.selectionStart;
    if (!c || caret !== input.selectionEnd) return close();
    const upto = input.value.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at < 0 || (at > 0 && /[\w@]/.test(upto[at - 1]))) return close();
    const q = upto.slice(at + 1).toLowerCase();
    if (q.length > 32 || q.includes("\n")) return close();
    const items = peers(c).filter((m) => m.name && m.name.toLowerCase().startsWith(q) && m.name.toLowerCase() !== q);
    if (!items.length) return close();
    state = { start: at, items, idx: Math.min(state?.idx ?? 0, items.length - 1) };
    render();
  };

  input.addEventListener("input", update);
  input.addEventListener("click", update);
  input.addEventListener("blur", () => setTimeout(close, 100));
  return {
    el: list,
    /** Returns true if the key was handled by the popup. */
    onKey(e) {
      if (!state) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = state.items.length;
        state.idx = (state.idx + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        render();
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(state.idx);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return true;
      }
      return false;
    },
  };
}

/** Ids of members whose @name appears in the text. */
function mentionIds(c, text) {
  const lower = text.toLowerCase();
  return peers(c)
    .filter((m) => m.name && new RegExp(`(^|[^\\w@])@${escapeRe(m.name.toLowerCase())}(?![\\w])`).test(lower))
    .map((m) => m.id);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------- modals

function sendFileModal(c) {
  const path = h("input.input", { type: "text", placeholder: "/home/you/Documents/report.pdf", spellcheck: "false", autocomplete: "off", "data-autofocus": true });
  const ps = peers(c);
  let select = null;
  if (c.kind === "group") {
    select = h(
      "select.input",
      null,
      h("option", { value: "" }, "Choose a member…"),
      ps.map((m) => h("option", { value: m.id }, `${m.name || m.id.slice(0, 8)} (${shortFp(m.fingerprint)})`)),
    );
  }
  const submit = h("button.btn.primary", { type: "submit", form: "send-file-form" }, "Request send");
  const form = h(
    "form",
    { id: "send-file-form" },
    field(
      "File path on this computer",
      path,
      "Browsers can't tell a page where a file lives, so type or paste its absolute path. Spencer copies it to its outgoing folder; you approve it before it is offered.",
    ),
    select ? field("Recipient", select) : h("p.hint", null, `To ${ps[0]?.name ?? "the other member"} via croc, end-to-end encrypted.`),
  );
  const modal = openModal({
    title: `Send a file to ${channelTitle(c)}`,
    body: form,
    footer: [h("button.btn", { type: "button", on: { click: () => modal.close() } }, "Cancel"), submit],
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = path.value.trim();
    if (!p) return path.focus();
    if (!p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith("~")) {
      toast("Please use an absolute path (starting with /)");
      return path.focus();
    }
    if (select && !select.value) {
      toast("Choose who gets the file");
      return select.focus();
    }
    submit.disabled = true;
    const t = await attempt(() => api.sendFile(c.id, p, select?.value || undefined));
    submit.disabled = false;
    if (t && t.tid) {
      upsertTransfer(t);
      modal.close();
      toast(t.state === "awaiting_approval" ? "File staged — approve it to offer it" : "File offered", "info");
    }
  });
}

function settingsModal(c) {
  const name = h("input.input", { type: "text", value: c.name, maxlength: "100" });
  const autoReply = h("input", { type: "checkbox", checked: c.autoReply, role: "switch" });
  const toolsBox = h("div.tool-checks", null, h("p.hint", null, "Loading MCP tools…"));
  const selected = new Set(c.allowedMcpTools ?? []);
  let trust = c.trust === "full" ? "full" : "standard";
  const trustOption = (value, title, desc) => {
    const radio = h("input", { type: "radio", name: "trust", value, checked: trust === value });
    radio.addEventListener("change", () => {
      if (radio.checked) {
        trust = value;
        syncTrust();
      }
    });
    return h("label.trust-option", null, radio, h("span", null, h("strong", null, title), h("span.hint.block", null, desc)));
  };
  const toolsField = h("div.field");
  const syncTrust = () => {
    toolsField.hidden = trust === "full";
    fullWarn.hidden = trust !== "full";
  };
  const fullWarn = h(
    "div.callout.warn",
    null,
    icon("warn", 16),
    h(
      "span",
      null,
      "Peers in this channel can make your Spencer use every MCP tool (for T3 Code: start threads, run agents with their access level) and receive files without your approval. You still see every tool call in your Spencer chat. Only pick this for people you trust like yourself.",
    ),
  );

  const renderTools = () => {
    const tools = allMcpTools();
    const names = new Set(tools.map((t) => t.name));
    const missing = [...selected].filter((t) => !names.has(t));
    if (!tools.length && !missing.length) {
      toolsBox.replaceChildren(h("p.hint", null, "No MCP tools available. Add MCP servers in Spencer's config."));
      return;
    }
    const byServer = new Map();
    for (const t of tools) {
      if (!byServer.has(t.server)) byServer.set(t.server, []);
      byServer.get(t.server).push(t);
    }
    const check = (tname, desc, extra) => {
      const cb = h("input", { type: "checkbox", checked: selected.has(tname), on: { change: () => (cb.checked ? selected.add(tname) : selected.delete(tname)) } });
      return h("label.check", { title: desc ?? "" }, cb, h("span.check-text", null, h("code", null, tname), extra ? h("span.muted", null, ` ${extra}`) : null, desc ? h("span.check-desc", null, desc) : null));
    };
    append(clear(toolsBox), [
      ...[...byServer].map(([server, ts]) => h("fieldset.tool-group", null, h("legend", null, server), ts.map((t) => check(t.name, t.description)))),
      missing.length ? h("fieldset.tool-group", null, h("legend", null, "Unavailable"), missing.map((t) => check(t, undefined, "(server not connected)"))) : null,
    ]);
  };

  const saveBtn = h("button.btn.primary", { type: "submit", form: "settings-form" }, "Save");
  const leaveArea = h("div.danger-zone");
  const renderLeave = (confirming) => {
    if (!confirming) {
      leaveArea.replaceChildren(
        h("div", null, h("strong", null, "Leave channel"), h("p.hint", null, "You'll stop receiving its messages and it disappears from this list.")),
        h("button.btn.danger", { type: "button", on: { click: () => renderLeave(true) } }, "Leave…"),
      );
      return;
    }
    const yes = h(
      "button.btn.danger",
      {
        type: "button",
        on: {
          click: async () => {
            yes.disabled = true;
            const r = await attempt(() => api.leaveChannel(c.id));
            yes.disabled = false;
            if (r) {
              modal.close();
              removeChannel(c.id);
              navigate({ name: "owner" });
              toast(`Left ${channelTitle(c)}`, "info");
            }
          },
        },
      },
      "Yes, leave",
    );
    leaveArea.replaceChildren(
      h("div", null, h("strong", null, `Leave “${channelTitle(c)}”?`), h("p.hint", null, c.kind === "direct" ? "Direct invite links can't be reused, so you'd need a new invite to talk again." : "You'd need the invite link again to rejoin.")),
      h("div.row", null, h("button.btn", { type: "button", on: { click: () => renderLeave(false) } }, "Cancel"), yes),
    );
    yes.focus();
  };
  renderLeave(false);

  const policy = S.policy ?? {};
  const form = h(
    "form",
    { id: "settings-form" },
    field("Name", name, c.kind === "direct" ? "Your private label for this channel. Peers don't see it." : "Your label for this group."),
    h(
      "label.switch-row",
      null,
      autoReply,
      h(
        "span",
        null,
        h("strong", null, "Auto-reply"),
        h(
          "span.hint.block",
          null,
          `Your Spencer answers peer messages on its own${c.kind === "group" ? " when mentioned" : ""}. Limits: ${policy.maxHops ?? 4} hops, ${policy.repliesPerMinute ?? 6}/min, ${policy.repliesPerHour ?? 60}/hour.`,
        ),
      ),
    ),
    h(
      "div.field",
      null,
      h("div.label", null, "Trust"),
      h(
        "div.trust-options",
        null,
        trustOption(
          "standard",
          "Standard",
          "Your Spencer chats on its own but asks you (Approve / Deny) before doing tasks for them. File sends need your approval. Only the MCP tools picked below.",
        ),
        trustOption("full", "Full trust", "No approvals: your Spencer does what they ask with all its MCP tools and sends files right away."),
      ),
      fullWarn,
    ),
    append(toolsField, [
      h("div.label", null, "MCP tools this channel's agent may use without asking"),
      h("div.callout.warn", null, icon("warn", 16), h("span", null, "MCP tools let peers in this channel trigger real actions on your machine through your Spencer. Only allow tools you'd let them run.")),
      toolsBox,
    ]),
  );
  syncTrust();
  const modal = openModal({
    title: `${channelTitle(c)} settings`,
    wide: true,
    body: [form, leaveArea],
    footer: [h("button.btn", { type: "button", on: { click: () => modal.close() } }, "Cancel"), saveBtn],
  });
  renderTools();
  attempt(() => api.mcp()).then((r) => {
    if (r && Array.isArray(r.servers)) {
      S.mcp = r.servers;
      renderTools();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const patch = {};
    const n = name.value.trim();
    if (n && n !== c.name) patch.name = n;
    if (autoReply.checked !== c.autoReply) patch.autoReply = autoReply.checked;
    if (trust !== (c.trust ?? "standard")) patch.trust = trust;
    const tools = [...selected].sort();
    if (JSON.stringify(tools) !== JSON.stringify([...(c.allowedMcpTools ?? [])].sort())) patch.allowedMcpTools = tools;
    if (!Object.keys(patch).length) return modal.close();
    saveBtn.disabled = true;
    const updated = await attempt(() => api.patchChannel(c.id, patch));
    saveBtn.disabled = false;
    if (updated && updated.id) {
      upsertChannel(updated);
      modal.close();
      toast("Settings saved", "info");
    }
  });
}

// ---------------------------------------------------------------- view

export function channelView(main, chId) {
  const getC = () => S.channels.get(chId);
  const header = h("div.header-slot");
  const timeline = h("div.transcript", { role: "log", "aria-live": "polite", "aria-label": "Channel messages" });
  const olderBtn = h("button.btn.sm.load-older", { type: "button", hidden: true }, "Load older messages");
  const workingBox = h("div.working-list", { role: "status", "aria-live": "polite" });
  const scroller = h("div.scroller", null, olderBtn, timeline, workingBox);
  const input = h("textarea.composer-input", { rows: "1", placeholder: "Message as yourself (human)…", "aria-label": "Message as yourself", "aria-autocomplete": "list" });
  const completer = mentionCompleter(input, getC);
  const fileBtn = h("button.icon-btn.attach", { type: "button", "aria-label": "Send file", title: "Send file", on: { click: () => getC() && sendFileModal(getC()) } }, icon("paperclip", 18));
  const sendBtn = h("button.send-btn", { type: "submit", "aria-label": "Send", title: "Send (Enter)" }, icon("send", 18));
  const form = h(
    "form.composer",
    null,
    completer.el,
    h("div.composer-box", null, fileBtn, input, sendBtn),
    h("p.composer-hint", null, "Sent as you (human, hop 0) · type @ to mention · Enter to send, Shift+Enter for a new line"),
  );
  main.append(header, scroller, form);
  const keeper = scrollKeeper(scroller);
  let hasOlder = false;

  const renderHeader = () => {
    const c = getC();
    if (!c) return;
    const title = channelTitle(c);
    const subtitle = c.kind === "direct" ? (c.name && c.name !== title ? `Direct · ${c.name}` : "Direct") : `Group · ${c.members.length} member${c.members.length === 1 ? "" : "s"}`;
    const chips = h(
      "div.member-chips",
      { "aria-label": "Members" },
      c.members.map((m) =>
        h(
          `span.chip${m.me ? ".me" : ""}`,
          { title: `${m.name ?? "(no name yet)"}${m.me ? " (you)" : ""}\nFingerprint ${m.fingerprint}\nid ${m.id}`, tabindex: "0" },
          avatar(m.name ?? "?", m.id, "xs"),
          m.me ? "You" : (m.name ?? `${m.id.slice(0, 6)}…`),
        ),
      ),
    );
    header.replaceChildren(
      viewHeader(
        [
          c.kind === "group" ? h("span.avatar.group", { "aria-hidden": "true" }, icon("users", 16)) : avatar(title, peers(c)[0]?.id ?? c.id),
          h("div.title-stack", null, h("h1", null, title), h(
            "span.subtitle",
            null,
            subtitle,
            c.trust === "full" ? h("span.pill.warn.inline", { title: "Peers here can use your Spencer's MCP tools without approval" }, "full trust") : null,
            c.autoReply ? null : h("span.pill.muted.inline", null, "auto-reply off"),
          )),
        ],
        [chips, iconButton("paperclip", "Send file", () => sendFileModal(c), "hide-narrow"), iconButton("gear", "Channel settings", () => settingsModal(c))],
      ),
    );
  };

  const renderTimeline = () => {
    const c = getC();
    if (!c) return;
    keeper.before();
    const msgs = S.messages.get(chId);
    if (!msgs) {
      timeline.replaceChildren(h("div.loading", null, "Loading messages…"));
      keeper.after();
      return;
    }
    const byId = new Map(msgs.map((m) => [m.id, m]));
    const names = [S.me?.name, ...c.members.map((m) => m.name)].filter(Boolean);
    const myNames = [S.me?.name, ...c.members.filter((m) => m.me).map((m) => m.name)].filter(Boolean);
    const items = [
      ...msgs.map((m) => ({ ts: m.ts, node: () => messageRow(c, m, byId, names, myNames) })),
      ...[...S.transfers.values()].filter((t) => t.ch === chId).map((t) => ({ ts: t.createdAt, node: () => h("div.xfer-inline", null, transferCard(t)) })),
    ].sort((a, b) => a.ts - b.ts);
    const nodes = [];
    if (!peers(c).length) {
      nodes.push(h("div.callout.info", null, icon("link", 16), h("span", null, "Nobody has joined yet. Send your invite link privately; messages show up here once they connect.")));
    }
    if (!items.length) {
      nodes.push(h("div.empty-state", null, h("p", null, "No messages yet."), h("p.hint", null, "Say hi, or ask your Spencer (pinned at the top) to talk here for you.")));
    }
    let lastDay = "";
    for (const it of items) {
      const day = new Date(it.ts).toDateString();
      if (day !== lastDay) {
        nodes.push(h("div.day-sep", null, h("span", null, new Date(it.ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }))));
        lastDay = day;
      }
      nodes.push(it.node());
    }
    timeline.replaceChildren(...nodes);
    olderBtn.hidden = !hasOlder;
    keeper.after();
  };

  const load = async () => {
    const r = await attempt(() => api.channelMessages(chId, 100));
    if (!r) return;
    const items = r.items ?? [];
    hasOlder = items.length >= 100;
    setMessages(chId, items);
    requestAnimationFrame(() => keeper.toBottom());
  };

  olderBtn.addEventListener("click", async () => {
    const msgs = S.messages.get(chId) ?? [];
    const first = msgs[0];
    if (!first) return;
    olderBtn.disabled = true;
    const r = await attempt(() => api.channelMessages(chId, 100, first.id));
    olderBtn.disabled = false;
    if (!r) return;
    const older = (r.items ?? []).filter((m) => !msgs.some((x) => x.id === m.id));
    hasOlder = (r.items ?? []).length >= 100;
    const prevH = scroller.scrollHeight;
    setMessages(chId, [...older, ...(S.messages.get(chId) ?? [])]);
    scroller.scrollTop = scroller.scrollHeight - prevH;
  });

  const send = async () => {
    const c = getC();
    const text = input.value.trim();
    if (!c || !text) return;
    input.value = "";
    autoGrow(input);
    const res = await attempt(() => api.channelSend(c.id, text, mentionIds(c, text)));
    if (!res) {
      input.value = text;
      autoGrow(input);
    } else {
      keeper.toBottom();
    }
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  input.addEventListener("keydown", (e) => {
    if (completer.onKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener("input", () => autoGrow(input));

  const onChannel = () => {
    if (!getC()) return; // removed: the router moves away
    renderHeader();
    renderTimeline();
  };
  const onMessages = () => {
    renderTimeline();
    markRead(chId);
  };
  const onVisible = () => document.visibilityState === "visible" && markRead(chId);

  renderHeader();
  renderTimeline();
  markRead(chId);
  load();
  requestAnimationFrame(() => input.focus());

  document.addEventListener("visibilitychange", onVisible);
  const onTransfer = (t) => {
    if (t && t.ch !== chId) return;
    // Progress ticks: swap just that card so the transcript (and any text selection) stays put.
    const existing = t && timeline.querySelector(`.xfer-card[data-tid="${CSS.escape(t.tid)}"]`);
    if (existing) existing.replaceWith(transferCard(t));
    else renderTimeline();
  };
  // "PJalv's Spencer · Using t3code · thread read…" while a Spencer works on a reply (Grok-style).
  const renderWorking = () => {
    const c = getC();
    if (!c) return;
    keeper.before();
    const rows = workingIn(chId).map((w) => {
      const mine = w.from === S.me?.id;
      const mem = c.members.find((m) => m.id === w.from);
      const name = mine ? (S.me?.name ?? "Your Spencer") : (mem?.name ?? "A Spencer");
      return h(
        `div.working-row${mine ? ".mine" : ""}`,
        null,
        mine ? null : avatar(name, w.from, "xs"),
        h(
          "div.working-pill",
          null,
          h("span.dots", { "aria-hidden": "true" }, h("i"), h("i"), h("i")),
          h("strong", null, name),
          h("span.working-activity", null, w.activity),
        ),
      );
    });
    workingBox.replaceChildren(...rows);
    keeper.after();
  };
  renderWorking();
  const staleTimer = setInterval(() => workingIn(chId).length && renderWorking(), 15_000);
  const offs = [
    on(`channel:${chId}`, onChannel),
    on(`messages:${chId}`, onMessages),
    on("transfers", onTransfer),
    on(`working:${chId}`, renderWorking),
  ];
  return {
    destroy: () => {
      clearInterval(staleTimer);
      offs.forEach((f) => f());
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
