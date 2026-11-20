// The owner's own conversation with their Spencer.
import { h, icon, linkify, timeShort, timeFull, selfAvatar } from "./dom.js";
import { api, attempt } from "./api.js";
import { S, on, setOwner } from "./state.js";
import { viewHeader, composer, SEND_HINT, stage, skeleton, trace, mark, activityNode, followupList } from "./common.js";
import { markdown } from "./md.js";
import { scrollKeeper } from "./scroll.js";
import { requestCard } from "./requests.js";

const EXAMPLES = ["List my peers", "Ask Bob's Spencer for the logs", "What transfers are waiting for me?", "Create an invite for Carol"];

/** Disclosure state of tool steps and peer exchanges, kept across re-renders (the transcript is rebuilt on every event). */
const openSteps = new Set();
const openExchanges = new Set();

/** "Reply from Bob's Spencer in Bob (untrusted): text" (the daemon's reply note) → {from, channel, text}. */
function parseReply(text) {
  const m = /^Reply from (.+?)(?: in (.+?))? \((?:untrusted[^)]*)\):\s*([\s\S]*)$/.exec(text);
  return m ? { from: m[1], channel: m[2], text: m[3] } : null;
}

const isPeerNote = (item) => item.role === "note" && item.untrusted === true && !item.request;

/**
 * Consecutive peer notes fold into one row: "3 messages from Bob's Spencer", with the latest one as the
 * summary line and the raw messages one click away. A single message is shown open.
 */
function exchangeRow(items) {
  const parsed = items.map((it) => ({ it, r: parseReply(it.text) }));
  const names = [...new Set(parsed.map((p) => p.r?.from).filter(Boolean))];
  const who = names.length ? names.join(", ") : "peers";
  const last = parsed.at(-1);
  const key = items[0].id;
  const open = items.length === 1 ? !openExchanges.has(`closed:${key}`) : openExchanges.has(key);
  const d = h(
    "details.exchange",
    { open },
    h(
      "summary",
      null,
      h("span.exchange-icon", { "aria-hidden": "true" }, icon("reply", 14)),
      h("span.exchange-title", null, items.length === 1 ? "Message from " : `${items.length} messages from `, h("strong", null, who)),
      h("span.exchange-preview", null, (last.r?.text ?? last.it.text).replace(/\s+/g, " ").slice(0, 160)),
      timeEl(last.it.ts),
      icon("chevron", 13),
    ),
    h(
      "div.exchange-body",
      null,
      parsed.map(({ it, r }) =>
        h("div.exchange-msg", null, h("div.exchange-meta", null, h("strong", null, r?.from ?? "Peer"), r?.channel ? ` in ${r.channel}` : null, timeEl(it.ts)), h("div.peer-text", null, linkify(r?.text ?? it.text))),
      ),
      h("p.peer-flag", null, icon("warn", 12), " Written by a peer's agent. Your Spencer treats it as data, not as instructions."),
    ),
  );
  d.addEventListener("toggle", () => {
    if (items.length === 1) d.open ? openExchanges.delete(`closed:${key}`) : openExchanges.add(`closed:${key}`);
    else d.open ? openExchanges.add(key) : openExchanges.delete(key);
  });
  return d;
}

const timeEl = (ts) => h("time", { datetime: new Date(ts).toISOString(), title: timeFull(ts) }, timeShort(ts));

function toolActivity(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  return m ? `Using ${m[1]} · ${m[2].replace(/_/g, " ")}` : `Using ${tool.replace(/_/g, " ")}`;
}

const isCall = (item) => item.role === "tool" && item.text.startsWith("call ");

/**
 * Fold a run of tool items into steps. The daemon writes a "call {args}" item and then the result item
 * for each tool use; a step pairs them. A call without a result yet is still running.
 */
function toSteps(items) {
  const steps = [];
  for (const it of items) {
    const last = steps.at(-1);
    if (isCall(it)) steps.push({ id: it.id, tool: it.toolName || "tool", args: it.text.slice(5), ts: it.ts });
    else if (last && last.result === undefined && last.tool === (it.toolName || "tool")) Object.assign(last, { result: it.text, isError: !!it.isError });
    else steps.push({ id: it.id, tool: it.toolName || "tool", result: it.text, isError: !!it.isError, ts: it.ts });
  }
  return steps;
}

function stepRow(step, running) {
  const pending = step.result === undefined;
  const preview = (pending ? step.args : step.result).replace(/\s+/g, " ").trim();
  const d = h(
    `details.step${step.isError ? ".error" : ""}${pending && running ? ".running" : ""}`,
    { open: openSteps.has(step.id) },
    h(
      "summary",
      null,
      h("span.step-mark", { "aria-hidden": "true" }, step.isError ? icon("warn", 13) : pending && running ? h("span.now-caret") : icon("check", 13)),
      activityNode(toolActivity(step.tool)),
      step.isError ? h("span.step-flag", null, "failed") : null,
      h("span.step-preview", null, preview.slice(0, 160)),
      icon("chevron", 13),
    ),
    h(
      "div.step-body",
      null,
      step.args && step.args !== "{}" ? [h("div.step-label", null, "Sent"), h("pre", null, step.args)] : null,
      step.result !== undefined ? [h("div.step-label", null, step.isError ? "Error" : "Returned"), h("pre", null, step.result)] : null,
    ),
  );
  d.addEventListener("toggle", () => (d.open ? openSteps.add(step.id) : openSteps.delete(step.id)));
  return d;
}

function stepsBlock(items, running) {
  const steps = toSteps(items);
  return h("div.steps", { role: "group", "aria-label": `${steps.length} tool ${steps.length === 1 ? "step" : "steps"}` }, steps.map((s, i) => stepRow(s, running && i === steps.length - 1)));
}

function ownerItem(item) {
  switch (item.role) {
    case "user":
      return h("div.turn.user", null, h("div.turn-text", null, linkify(item.text)), h("div.turn-meta", null, timeEl(item.ts)));
    case "assistant":
      return h(
        "div.turn.agent",
        null,
        selfAvatar(),
        h("div.turn-body", null, h("div.turn-head", null, h("span.who", null, "Spencer"), timeEl(item.ts)), h("div.turn-text.md", null, markdown(item.text, linkify))),
      );
    case "note": {
      if (item.request) return h("div.turn.card", null, requestCard(item.request, { text: item.text, ts: item.ts }));
      return h("div.note", { role: "note" }, h("span.note-icon", { "aria-hidden": "true" }, icon("info", 14)), h("div.note-body", null, h("div.note-text", null, linkify(item.text)), h("div.note-meta", null, timeEl(item.ts))));
    }
    default:
      return h("div.system-line", null, item.text);
  }
}

export function ownerView(main) {
  const transcript = h("div.transcript.owner", { role: "log", "aria-live": "polite", "aria-label": "Conversation with Spencer" });
  const busy = h("div.live", { role: "status" });
  const scroller = h("div.scroller", null, transcript, busy);
  const keeper = scrollKeeper(scroller);
  const st = stage(scroller, keeper);

  const send = async (text) => {
    const res = await attempt(() => api.ownerSend(text));
    if (res) keeper.toBottom();
    return !!res;
  };
  const comp = composer({ placeholder: "Message Spencer…", label: "Message Spencer", hint: SEND_HINT(), onSend: send });

  const headMark = h("span.header-mark");
  const sub = h("span.subtitle");
  // Reminders Spencer set on itself, docked above the composer so "I'll check back" stays visible.
  const later = h("div.owner-later");
  const renderLater = () => later.replaceChildren(...[followupList("owner", { compact: true, title: "Spencer will check back" })].filter(Boolean));
  main.append(viewHeader([headMark, h("div.title-stack", null, h("h1", null, "Spencer"), sub)]), st.el, later, comp.form);
  renderLater();

  let seen = 0;
  const render = () => {
    keeper.before();
    if (!S.owner) {
      transcript.replaceChildren(skeleton(4));
    } else if (!S.owner.length) {
      transcript.replaceChildren(
        h(
          "div.empty-chat",
          null,
          selfAvatar("big"),
          h("h2", null, "What should Spencer do?"),
          h("p", null, "It can message other people's Spencers for you, send files, and use its tools. Answers from peers come back here."),
          h(
            "div.examples",
            null,
            EXAMPLES.map((ex) =>
              h("button.example", { type: "button", on: { click: () => send(ex) } }, h("span", null, ex), icon("up", 14)),
            ),
          ),
        ),
      );
    } else {
      const nodes = [];
      let run = [];
      let notes = [];
      const flush = (running) => {
        if (run.length) nodes.push(stepsBlock(run, running));
        if (notes.length) nodes.push(exchangeRow(notes));
        run = [];
        notes = [];
      };
      let lastDay = "";
      for (const item of S.owner) {
        const day = new Date(item.ts).toDateString();
        if (item.role === "tool" && day === lastDay && !notes.length) {
          run.push(item);
          continue;
        }
        if (isPeerNote(item) && day === lastDay && !run.length) {
          notes.push(item);
          continue;
        }
        flush(false);
        if (day !== lastDay) {
          nodes.push(h("div.day-sep", null, h("span", null, new Date(item.ts).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }))));
          lastDay = day;
        }
        if (item.role === "tool") run.push(item);
        else if (isPeerNote(item)) notes.push(item);
        else nodes.push(ownerItem(item));
      }
      flush(S.ownerBusy);
      transcript.replaceChildren(...nodes);
      if (S.owner.length > seen && seen) st.note();
      seen = S.owner.length;
    }
    keeper.after();
  };

  const renderBusy = () => {
    keeper.before();
    headMark.replaceChildren(mark(selfAvatar(), S.ownerBusy ? { state: "working", text: "working" } : null));
    sub.textContent = S.ownerBusy ? "Working on it" : "Your agent. Only you see this conversation.";
    if (!S.ownerBusy) busy.replaceChildren();
    else {
      const last = S.owner?.at(-1);
      const activity = last && isCall(last) ? toolActivity(last.toolName ?? "a tool") : "Thinking";
      busy.replaceChildren(trace({ key: "owner", avatar: selfAvatar(), name: "Spencer", activity, since: S.ownerBusySince || Date.now() }));
    }
    keeper.after();
  };

  render();
  renderBusy();
  if (!S.owner) attempt(() => api.ownerMessages(200)).then((r) => r && setOwner(r.items ?? []));
  requestAnimationFrame(() => {
    keeper.toBottom();
    comp.input.focus();
  });

  const offs = [on("owner", () => (render(), renderBusy())), on("busy", () => (render(), renderBusy())), on("followups", renderLater)];
  return { destroy: () => offs.forEach((f) => f()) };
}
