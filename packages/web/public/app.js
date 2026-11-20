// Spencer local UI: entry point. Sidebar, routing, and the events stream.
import { h, icon, shortFp, avatar, selfAvatar, clear, append } from "./dom.js";
import { api, attempt, toast, connectEvents } from "./api.js";
import {
  S,
  on,
  emit,
  setState,
  upsertChannel,
  removeChannel,
  upsertMessage,
  upsertTransfer,
  upsertOwner,
  setOwner,
  setMessages,
  unreadCount,
  actionCount,
  needsAction,
  peers,
  channelTitle,
} from "./state.js";
import { parseHash, hashFor, navigate } from "./router.js";
import { setSidebarOpen } from "./common.js";
import { ownerView } from "./owner.js";
import { channelView } from "./channel.js";
import { transfersView } from "./transfers.js";
import { mcpView } from "./mcp.js";
import { inviteModal, joinModal } from "./invites.js";

const sidebar = document.getElementById("sidebar");
const main = document.getElementById("main");

// ---------------------------------------------------------------- sidebar

function navItem(view, content, opts = {}) {
  const active = hashFor(view) === hashFor(S.view);
  return h(
    `a.nav-item${active ? ".active" : ""}${opts.cls ? "." + opts.cls : ""}`,
    { href: hashFor(view), "aria-current": active ? "page" : undefined, title: opts.title },
    content,
  );
}

function badge(n, label) {
  return n > 0 ? h("span.badge-count", { "aria-label": `${n} ${label}` }, n > 99 ? "99+" : String(n)) : null;
}

function renderSidebar() {
  const me = S.me;
  const relayUp = S.relay?.connected && S.wsUp;
  const relayTitle = !S.wsUp ? "Not connected to the Spencer daemon" : S.relay?.connected ? `Relay connected — ${S.relay.url}` : `Relay disconnected — ${S.relay?.url ?? ""}`;
  const channels = [...S.channels.values()].sort((a, b) => a.createdAt - b.createdAt);
  const direct = channels.filter((c) => c.kind === "direct");
  const groups = channels.filter((c) => c.kind === "group");

  const channelItem = (c) => {
    const title = channelTitle(c);
    const n = unreadCount(c.id);
    let sub;
    if (c.kind === "group") sub = `${c.members.length} member${c.members.length === 1 ? "" : "s"}`;
    else {
      const p = peers(c)[0];
      sub = p ? shortFp(p.fingerprint) : "invite pending";
    }
    return navItem(
      { name: "channel", ch: c.id },
      [
        c.kind === "group" ? h("span.avatar.group.sm", { "aria-hidden": "true" }, icon("users", 14)) : avatar(title, peers(c)[0]?.id ?? c.id, "sm"),
        h("span.nav-text", null, h("span.nav-name", null, title), h("span.nav-sub", null, sub)),
        badge(n, "unread"),
      ],
      { cls: n ? "unread" : "", title: c.kind === "direct" && c.name !== title ? `${title} (${c.name})` : title },
    );
  };

  const section = (label, items, emptyText) =>
    h(
      "section.nav-section",
      { "aria-label": label },
      h("h2.nav-heading", null, label, items.length ? h("span.nav-heading-count", null, String(items.length)) : null),
      items.length ? items.map(channelItem) : h("p.nav-empty", null, emptyText),
    );

  const pending = actionCount();
  const mcpBad = S.mcp.some((s) => s.status === "error");

  // Rebuilding the sidebar would drop keyboard focus; remember what had it.
  const focused = sidebar.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused ? focused.getAttribute("href") ?? focused.textContent : null;

  append(clear(sidebar), [
    h(
      "header.side-head",
      null,
      selfAvatar(),
      h(
        "div.side-id",
        null,
        h("div.side-name", null, me?.name ?? "Spencer"),
        h("code.side-fp", { title: me ? `Your fingerprint ${me.fingerprint}\nid ${me.id}` : "" }, me ? shortFp(me.fingerprint) : "…"),
      ),
      h(`span.relay-dot${relayUp ? ".up" : ""}`, { role: "img", "aria-label": relayTitle, title: relayTitle }),
      h("button.icon-btn.close-side", { type: "button", "aria-label": "Close sidebar", on: { click: () => setSidebarOpen(false) } }, icon("close", 18)),
    ),
    S.wsUp ? null : h("div.side-banner", { role: "status" }, "Reconnecting to Spencer…"),
    h(
      "nav.side-nav",
      { "aria-label": "Conversations" },
      navItem(
        { name: "owner" },
        [
          selfAvatar("sm"),
          h("span.nav-text", null, h("span.nav-name", null, "Spencer"), h("span.nav-sub", null, S.ownerBusy ? "working…" : "Your agent")),
          S.ownerBusy ? h("span.busy-dot", { "aria-label": "busy" }) : null,
        ],
        { cls: "pinned" },
      ),
      section("Direct", direct, "No direct channels yet."),
      section("Groups", groups, "No groups yet."),
      h(
        "div.side-actions",
        null,
        h("button.btn.sm", { type: "button", on: { click: inviteModal } }, icon("plus", 14), " Invite"),
        h("button.btn.sm", { type: "button", on: { click: joinModal } }, icon("link", 14), " Join"),
      ),
    ),
    h(
      "footer.side-foot",
      null,
      navItem({ name: "transfers" }, [icon("transfer", 16), h("span.nav-name", null, "Transfers"), badge(pending, "need action")], { cls: "foot" }),
      navItem({ name: "mcp" }, [icon("plug", 16), h("span.nav-name", null, "MCP servers"), mcpBad ? h("span.dot.error", { "aria-label": "a server has an error" }) : null], { cls: "foot" }),
    ),
  ]);
  if (focusKey) {
    const again = [...sidebar.querySelectorAll("a, button")].find((el) => (el.getAttribute("href") ?? el.textContent) === focusKey);
    again?.focus();
  }
}

// ---------------------------------------------------------------- routing

let current = null;
let mountedKey = "";

function mount() {
  const view = S.view;
  const key = hashFor(view);
  if (view.name === "channel" && !S.channels.has(view.ch)) {
    if (S.loaded) {
      navigate({ name: "owner" });
      return;
    }
    current?.destroy?.();
    current = null;
    mountedKey = "";
    clear(main).append(h("div.loading.center", null, "Loading…"));
    return;
  }
  if (key === mountedKey && current) return;
  current?.destroy?.();
  clear(main);
  main.className = `main view-${view.name}`;
  mountedKey = key;
  if (view.name === "channel") current = channelView(main, view.ch);
  else if (view.name === "transfers") current = transfersView(main);
  else if (view.name === "mcp") current = mcpView(main);
  else current = ownerView(main);
}

function onRoute() {
  S.view = parseHash();
  setSidebarOpen(false);
  mount();
  renderSidebar();
  const c = S.view.name === "channel" ? S.channels.get(S.view.ch) : null;
  document.title = c ? `${channelTitle(c)} · Spencer` : S.view.name === "owner" ? "Spencer" : `${S.view.name === "mcp" ? "MCP servers" : "Transfers"} · Spencer`;
}

// ---------------------------------------------------------------- events

function handleEvent(ev) {
  switch (ev.type) {
    case "channel":
      if (ev.channel?.id) upsertChannel(ev.channel);
      break;
    case "channel_removed":
      removeChannel(ev.ch);
      if (S.view.name === "channel" && S.view.ch === ev.ch) {
        toast("This channel was removed", "info");
        navigate({ name: "owner" });
      }
      break;
    case "message":
      if (ev.ch && ev.message?.id) upsertMessage(ev.ch, ev.message);
      break;
    case "transfer": {
      const t = ev.transfer;
      if (!t?.tid) break;
      const prev = S.transfers.get(t.tid);
      upsertTransfer(t);
      if (needsAction(t) && t.initiatedBy !== "owner" && (!prev || prev.state !== t.state) && S.view.name !== "transfers") {
        const who = t.peerName ?? "A peer";
        toast(t.direction === "in" ? `${who} wants to send you ${t.name}` : `${t.name} needs your approval to send`, "info");
      }
      break;
    }
    case "owner":
      if (ev.item?.id) upsertOwner(ev.item);
      break;
    case "owner_busy":
      S.ownerBusy = !!ev.busy;
      emit("busy");
      renderSidebar();
      break;
    case "relay":
      S.relay = { url: ev.url ?? S.relay.url, connected: !!ev.connected };
      emit("relay");
      break;
    case "mcp":
      if (Array.isArray(ev.servers)) {
        S.mcp = ev.servers;
        emit("mcp");
      }
      break;
    default:
      break;
  }
}

async function refresh(full) {
  const st = await attempt(() => api.state());
  if (st) {
    setState(st);
    mount();
  }
  if (!full) return;
  // Events may have been missed while disconnected: drop cached transcripts, reload the visible one.
  const viewing = S.view.name === "channel" ? S.view.ch : null;
  for (const ch of [...S.messages.keys()]) if (ch !== viewing) S.messages.delete(ch);
  if (viewing && S.channels.has(viewing)) {
    const r = await attempt(() => api.channelMessages(viewing, 100));
    if (r) setMessages(viewing, r.items ?? []);
  }
  if (S.owner) {
    const r = await attempt(() => api.ownerMessages(200));
    if (r) setOwner(r.items ?? []);
  }
}

// ---------------------------------------------------------------- boot

for (const t of ["channels", "transfers", "relay", "mcp"]) on(t, renderSidebar);
document.getElementById("backdrop")?.addEventListener("click", () => setSidebarOpen(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("app")?.classList.contains("sidebar-open")) setSidebarOpen(false);
});
window.addEventListener("hashchange", onRoute);

S.view = parseHash();
renderSidebar();
mount();
refresh(false);
connectEvents({
  onEvent: handleEvent,
  onOpen: (isReconnect) => refresh(isReconnect),
  onStatus: (up) => {
    S.wsUp = up;
    renderSidebar();
  },
});
