// "Needs you": everything waiting for the owner's decision, in one place.
// Pending ask_owner requests, outgoing files to approve, incoming files to accept.
import { h, icon } from "./dom.js";
import { api, attempt } from "./api.js";
import { S, on, needsAction, pendingRequests, setTransfers } from "./state.js";
import { viewHeader, emptyState } from "./common.js";
import { requestCard } from "./requests.js";
import { transferCard } from "./transfers.js";

export function inboxView(main) {
  const body = h("div.page-body");
  main.append(viewHeader([h("span.title-icon.attn", { "aria-hidden": "true" }, icon("inbox", 18)), h("div.title-stack", null, h("h1", null, "Needs you"), h("span.subtitle", null, "Decisions your Spencer is waiting on"))]), h("div.page", null, body));

  const render = () => {
    const pending = pendingRequests();
    const files = [...S.transfers.values()].filter(needsAction).sort((a, b) => a.createdAt - b.createdAt);
    const decided = [...S.requests.values()].filter((r) => r.state !== "pending").sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt)).slice(0, 8);
    const nodes = [];
    if (!pending.length && !files.length) {
      nodes.push(
        emptyState({
          icon: "check",
          title: "Nothing needs you",
          text: "When another person's Spencer asks yours to do something, or a file needs your approval, it shows up here.",
        }),
      );
    }
    if (pending.length) {
      nodes.push(h("section.inbox-section", { "aria-label": "Requests" }, h("h2.section-title", null, "Requests", h("span.count", null, String(pending.length))), pending.map((r) => requestCard(r.id))));
    }
    if (files.length) {
      nodes.push(h("section.inbox-section", { "aria-label": "Files" }, h("h2.section-title", null, "Files", h("span.count", null, String(files.length))), files.map((t) => transferCard(t, { showChannel: true }))));
    }
    if (decided.length) {
      nodes.push(h("section.inbox-section.quiet", { "aria-label": "Decided" }, h("h2.section-title", null, "Decided"), decided.map((r) => requestCard(r.id))));
    }
    body.replaceChildren(...nodes);
  };
  render();
  attempt(() => api.transfers()).then((r) => r && Array.isArray(r.items) && setTransfers(r.items));
  const offs = [on("requests", render), on("transfers", render), on("channels", render)];
  return { destroy: () => offs.forEach((f) => f()) };
}
