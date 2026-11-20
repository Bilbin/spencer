// In-memory UI state plus a tiny pub/sub. Views subscribe to topics and re-render their part.

export const TERMINAL = new Set(["completed", "denied", "declined", "failed", "expired", "cancelled"]);

export const S = {
  me: null, // {id, name, fingerprint}
  relay: { url: "", connected: false },
  policy: {},
  channels: new Map(), // id -> Channel
  transfers: new Map(), // tid -> Transfer
  mcp: [], // McpServerStatus[]
  messages: new Map(), // ch -> ChannelMessage[] (only for channels that were opened)
  owner: null, // OwnerItem[] once loaded
  ownerBusy: false,
  wsUp: false,
  loaded: false,
  view: { name: "owner" }, // {name:"owner"} | {name:"channel", ch} | {name:"transfers"} | {name:"mcp"}
  /** Server unread count already "seen" per channel (persisted), and locally counted unread. */
  ack: loadAck(),
  local: {},
};

const listeners = new Map(); // topic -> Set<fn>

export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic)?.delete(fn);
}

export function emit(topic, detail) {
  for (const fn of listeners.get(topic) ?? []) {
    try {
      fn(detail);
    } catch (err) {
      console.error(`listener for ${topic} failed`, err);
    }
  }
}

// ---------------------------------------------------------------- unread

function loadAck() {
  try {
    return JSON.parse(localStorage.getItem("spencer.ack") ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function saveAck() {
  try {
    localStorage.setItem("spencer.ack", JSON.stringify(S.ack));
  } catch {
    /* storage unavailable: badges just reset on reload */
  }
}

/**
 * Badge count: the server's unread count minus what we already saw while the channel was open,
 * or the locally counted messages, whichever is larger (the daemon may or may not bump `unread`
 * for each message, and there is no "mark read" endpoint).
 */
export function unreadCount(ch) {
  const c = S.channels.get(ch);
  if (!c) return 0;
  const server = Math.max(0, (c.unread ?? 0) - (S.ack[ch] ?? 0));
  return Math.max(server, S.local[ch] ?? 0);
}

export function markRead(ch) {
  const c = S.channels.get(ch);
  if (!c) return;
  const before = unreadCount(ch);
  S.ack[ch] = c.unread ?? 0;
  S.local[ch] = 0;
  saveAck();
  if (before) emit("channels");
}

export function isViewing(ch) {
  return S.view.name === "channel" && S.view.ch === ch && document.visibilityState !== "hidden";
}

// ---------------------------------------------------------------- mutations

export function setState(st) {
  S.me = st.me ?? S.me;
  S.relay = st.relay ?? S.relay;
  S.policy = st.policy ?? {};
  S.channels = new Map((st.channels ?? []).map((c) => [c.id, c]));
  S.transfers = new Map((st.transfers ?? []).map((t) => [t.tid, t]));
  S.mcp = st.mcp ?? [];
  for (const ch of Object.keys(S.ack)) {
    const c = S.channels.get(ch);
    // The server count dropped (e.g. it marked messages read): don't hide future ones.
    if (!c) delete S.ack[ch];
    else if ((c.unread ?? 0) < S.ack[ch]) S.ack[ch] = c.unread ?? 0;
  }
  for (const ch of S.channels.keys()) if (isViewing(ch)) S.ack[ch] = S.channels.get(ch).unread ?? 0;
  saveAck();
  S.loaded = true;
  emit("channels");
  emit("transfers");
  emit("relay");
  emit("mcp");
}

export function upsertChannel(c) {
  S.channels.set(c.id, c);
  if (isViewing(c.id)) {
    S.ack[c.id] = c.unread ?? 0;
    saveAck();
  }
  emit("channels");
  emit(`channel:${c.id}`);
}

export function removeChannel(ch) {
  S.channels.delete(ch);
  S.messages.delete(ch);
  delete S.ack[ch];
  delete S.local[ch];
  saveAck();
  emit("channels");
  emit(`channel:${ch}`);
}

export function setMessages(ch, items) {
  S.messages.set(ch, [...items].sort(byOrder));
  emit(`messages:${ch}`);
}

const counted = new Set(); // message ids already counted as unread

export function upsertMessage(ch, m) {
  const list = S.messages.get(ch);
  let isNew = !counted.has(m.id);
  if (list) {
    const i = list.findIndex((x) => x.id === m.id);
    if (i >= 0) {
      list[i] = { ...list[i], ...m };
      isNew = false;
    } else {
      list.push(m);
      list.sort(byOrder);
    }
  }
  if (isNew && !m.mine && m.type === "chat" && !isViewing(ch)) {
    counted.add(m.id);
    S.local[ch] = (S.local[ch] ?? 0) + 1;
    emit("channels");
  }
  emit(`messages:${ch}`);
}

function byOrder(a, b) {
  if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq - b.seq;
  return a.ts - b.ts;
}

export function setTransfers(items) {
  S.transfers = new Map(items.map((t) => [t.tid, t]));
  emit("transfers");
}

export function upsertTransfer(t) {
  S.transfers.set(t.tid, t);
  emit("transfers", t);
}

export function setOwner(items) {
  S.owner = items;
  emit("owner");
}

export function upsertOwner(item) {
  if (!S.owner) return; // not loaded yet; the next load includes it
  const i = S.owner.findIndex((x) => x.id === item.id);
  if (i >= 0) S.owner[i] = item;
  else S.owner.push(item);
  emit("owner");
}

// ---------------------------------------------------------------- derived

export function needsAction(t) {
  return (t.direction === "out" && t.state === "awaiting_approval") || (t.direction === "in" && t.state === "offered");
}

export function actionCount() {
  let n = 0;
  for (const t of S.transfers.values()) if (needsAction(t)) n++;
  return n;
}

export function peers(c) {
  return (c?.members ?? []).filter((m) => !m.me);
}

export function memberName(c, id) {
  const m = c?.members.find((x) => x.id === id);
  return m?.name;
}

/** Display name of a channel: direct channels show the peer's name. */
export function channelTitle(c) {
  if (!c) return "Unknown channel";
  if (c.kind === "direct") {
    const p = peers(c)[0];
    return p?.name || c.name || "Waiting for peer…";
  }
  return c.name || "Unnamed group";
}

export function allMcpTools() {
  const out = [];
  for (const s of S.mcp) for (const t of s.tools ?? []) out.push({ server: s.name, ...t });
  return out;
}
