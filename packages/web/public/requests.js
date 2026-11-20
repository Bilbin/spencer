// An ask_owner request: something a peer's Spencer wants done that needs the owner's go-ahead.
// The same card is used in the owner chat and in "Needs you".
import { h, icon, linkify, timeShort, timeFull, relTime, avatar } from "./dom.js";
import { api, attempt, toast } from "./api.js";
import { S, upsertRequest } from "./state.js";

/**
 * requestCard(id, {text, ts}): `text` and `ts` are the fallback from the owner-chat note when the
 * request itself is not loaded. The text is written from untrusted peer input.
 */
export function requestCard(id, fallback = {}) {
  const r = S.requests.get(id);
  const state = r?.state ?? "pending";
  const who = r?.fromName ?? "A peer's Spencer";
  const ts = r?.createdAt ?? fallback.ts;
  const text = r?.text ?? fallback.text ?? "";
  const channel = r && S.channels.has(r.ch) ? h("a.ask-where", { href: `#/c/${encodeURIComponent(r.ch)}` }, r.channelName || "channel") : r?.channelName ? h("span.ask-where", null, r.channelName) : null;

  // What saying yes means, as facts about this request (not guesses from the peer's text).
  const trust = r ? S.channels.get(r.ch)?.trust : undefined;
  const chips = [
    h("span.chip.risk", { title: "Approving runs this in your own Spencer conversation, with every tool it has: MCP servers, files, shell." }, icon("terminal", 12), "Runs with all your tools"),
    h("span.chip", { title: "The description below was written by your channel agent from a peer's message." }, icon("warn", 12), "Peer-written"),
    trust ? h("span.chip", { title: trust === "full" ? "This channel is set to full trust." : "This channel is set to standard trust, which is why you are being asked." }, icon("shield", 12), trust === "full" ? "Full-trust channel" : "Standard-trust channel") : null,
  ];

  let foot;
  if (state === "pending") {
    const approve = h("button.btn.primary", { type: "button" }, "Approve");
    const deny = h("button.btn", { type: "button" }, "Deny");
    const decide = async (yes) => {
      approve.disabled = deny.disabled = true;
      const res = await attempt(() => api.decideRequest(id, yes));
      if (res?.id) {
        upsertRequest(res);
        toast(yes ? "Approved. Your Spencer is on it." : `Denied. ${who} was told.`, "info");
      } else approve.disabled = deny.disabled = false;
    };
    approve.addEventListener("click", () => decide(true));
    deny.addEventListener("click", () => decide(false));
    // The action row wraps, so further choices ("Allow once", "Always allow") fit here when the API has them.
    foot = h("div.ask-foot", null, h("p.ask-hint", null, "If you approve, your Spencer does it and reports back to the channel."), h("div.ask-actions", null, deny, approve));
  } else {
    const when = r?.decidedAt ? h("time", { datetime: new Date(r.decidedAt).toISOString(), title: timeFull(r.decidedAt) }, timeShort(r.decidedAt)) : null;
    foot = h("div.ask-foot.decided", null, icon(state === "approved" ? "check" : "close", 14), h("span", null, state === "approved" ? "You approved this" : "You denied this", when ? " at " : null, when));
  }

  return h(
    `article.ask.${state}`,
    { "aria-label": `Request from ${who}`, dataset: { request: id } },
    h(
      "header.ask-head",
      null,
      avatar(who, r?.from ?? who, "sm"),
      h("div.ask-title", null, h("strong", null, who), state === "pending" ? " asks for your approval" : " asked for your approval", channel ? [" in ", channel] : null),
      ts ? h("time.ask-time", { datetime: new Date(ts).toISOString(), title: timeFull(ts), "data-rel": state === "pending" ? String(ts) : undefined }, state === "pending" ? `asked ${relTime(ts)}` : timeShort(ts)) : null,
    ),
    h("div.ask-text.peer-text", null, linkify(text)),
    state === "pending" ? h("div.ask-chips", null, chips) : null,
    foot,
  );
}
