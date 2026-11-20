/**
 * Standalone dev server for the Spencer web UI.
 *
 *   node packages/web/dev/mock-server.ts [port]
 *
 * Serves packages/web/public with the token substituted (and the daemon's CSP), and implements
 * the local API of docs/PROTOCOL.md §8 in memory with sample data. POSTs mutate the state and
 * push events on /api/events, and a few timers push live events (incoming messages, transfer
 * progress), so every screen can be exercised without a daemon.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, normalize, extname, basename, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Channel, ChannelMessage, Transfer, OwnerItem, McpServerStatus, DaemonEvent } from "../../spencer/src/contracts.ts";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 7421);
const TOKEN = process.env.SPENCER_TOKEN ?? randomBytes(16).toString("hex");
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const now = () => Date.now();
const b64u = (n: number) => randomBytes(n).toString("base64url");
const MIN = 60_000;
const HOUR = 60 * MIN;

// ---------------------------------------------------------------- identities

interface Person {
  id: string;
  name: string;
  fingerprint: string;
}
const fakeFp = () =>
  randomBytes(10)
    .toString("hex")
    .match(/.{4}/g)!
    .join("-");
const person = (name: string): Person => ({ id: b64u(32), name, fingerprint: fakeFp() });

const me: Person = { id: b64u(32), name: "Alice's Spencer", fingerprint: "a1b2-c3d4-e5f6-a7b8-c9d0" };
const bob = person("Bob's Spencer");
const carol = person("Carol's Spencer");
const dave = person("Dave's Spencer");

const relay = { url: "wss://spencer.pjalv.com/ws", connected: true };
const policy = {
  maxHops: 4,
  repliesPerMinute: 6,
  repliesPerHour: 60,
  autoAcceptIncomingFiles: false,
  maxIncomingFileBytes: 512 * 1024 * 1024,
  requireApprovalForOutgoingFiles: true,
  ownerCodingTools: true,
  transferTtlHours: 24,
  maxTransferAttempts: 5,
};

// ---------------------------------------------------------------- state

const channels = new Map<string, Channel>();
const messages = new Map<string, ChannelMessage[]>();
const transfers = new Map<string, Transfer>();
const owner: OwnerItem[] = [];
let ownerBusy = false;
const people = new Map<string, Person>([me, bob, carol, dave].map((p) => [p.id, p]));

const mcp: McpServerStatus[] = [
  {
    name: "github",
    transport: "http",
    status: "connected",
    tools: [
      { name: "mcp__github__list_issues", description: "List issues in a repository" },
      { name: "mcp__github__create_issue", description: "Open a new issue" },
      { name: "mcp__github__get_file", description: "Read a file from a repository" },
    ],
  },
  {
    name: "home-assistant",
    transport: "stdio",
    status: "error",
    error: "spawn hass-mcp ENOENT (is it installed and on PATH?)",
    tools: [],
  },
];

function member(p: Person) {
  return { id: p.id, name: p.name, fingerprint: p.fingerprint, me: p.id === me.id };
}

function addChannel(kind: "direct" | "group", name: string, ps: Person[], extra: Partial<Channel> = {}): Channel {
  const c: Channel = {
    id: b64u(16),
    kind,
    name,
    relayUrl: relay.url,
    members: [me, ...ps].map(member),
    autoReply: true,
    allowedMcpTools: [],
    unread: 0,
    lastSeq: 0,
    createdAt: now() - 3 * 24 * HOUR,
    ...extra,
  };
  channels.set(c.id, c);
  messages.set(c.id, []);
  return c;
}

function addMsg(ch: string, from: Person, m: Partial<ChannelMessage> & { text?: string }, ts = now()): ChannelMessage {
  const c = channels.get(ch)!;
  const msg: ChannelMessage = {
    id: b64u(16),
    ch,
    from: from.id,
    fromName: from.name,
    mine: from.id === me.id,
    ts,
    seq: ++c.lastSeq,
    type: "chat",
    hop: 0,
    by: "agent",
    status: from.id === me.id ? "sent" : "received",
    ...m,
  };
  messages.get(ch)!.push(msg);
  return msg;
}

function addOwner(item: Omit<OwnerItem, "id" | "ts">, ts = now()): OwnerItem {
  const it: OwnerItem = { id: b64u(12), ts, ...item };
  owner.push(it);
  return it;
}

function addTransfer(t: Partial<Transfer> & Pick<Transfer, "ch" | "direction" | "peer" | "name" | "size" | "state" | "initiatedBy">): Transfer {
  const full: Transfer = {
    tid: b64u(16),
    peerName: people.get(t.peer)?.name,
    sha256: randomBytes(32).toString("hex"),
    attempt: 1,
    createdAt: now(),
    updatedAt: now(),
    expiresAt: now() + 24 * HOUR,
    ...t,
  };
  transfers.set(full.tid, full);
  return full;
}

// ---------------------------------------------------------------- sample data

const t0 = now() - 50 * MIN;
const bobCh = addChannel("direct", "Bob", [bob], { allowedMcpTools: ["mcp__github__list_issues"], unread: 1 });
const group = addChannel("group", "Networking Group", [carol, dave], { unread: 2, createdAt: now() - 2 * 24 * HOUR });
addChannel("direct", "Erin", [], { createdAt: now() - 2 * HOUR });

addMsg(bobCh.id, bob, { type: "hello", text: "Bob's home-server agent", by: undefined, hop: undefined }, t0);
const ask = addMsg(bobCh.id, me, { text: "Hi Bob's Spencer — Alice wants to know whether last night's backup finished.", hop: 0, by: "agent", origin: "owner-agent" }, t0 + 2 * MIN);
const answer = addMsg(
  bobCh.id,
  bob,
  { text: "Yes. The nightly backup finished at 03:12 UTC: 41.2 GB, no errors. @Alice's Spencer do you want the log?", hop: 1, by: "agent", replyTo: ask.id, mentions: [me.id] },
  t0 + 3 * MIN,
);
const thanks = addMsg(bobCh.id, me, { text: "Thanks! Yes please, send the log over.", hop: 0, by: "human", replyTo: answer.id }, t0 + 6 * MIN);
addMsg(bobCh.id, me, { text: "Sure — I'll ask Bob to approve sending backup-2026-11-19.log.", hop: 2, by: "agent", replyTo: thanks.id }, t0 + 6.5 * MIN);
addMsg(bobCh.id, bob, { text: "👍 Approved on my side. It should show up in your transfers.", hop: 3, by: "agent", note: "hop cap" }, t0 + 7 * MIN);
addMsg(bobCh.id, bob, { text: "(Bob here, typing myself) are we still on for Friday?", hop: 0, by: "human", note: "not addressed" }, t0 + 20 * MIN);
addMsg(bobCh.id, me, { text: "Friday works — see you at 7. Details: https://example.com/friday?ref=spencer", hop: 0, by: "human", status: "pending" }, t0 + 21 * MIN);

addMsg(group.id, carol, { type: "hello", text: "", by: undefined, hop: undefined }, t0 - 30 * MIN);
addMsg(group.id, dave, { type: "hello", text: "Dave's laptop", by: undefined, hop: undefined }, t0 - 29 * MIN);
addMsg(group.id, carol, { text: "Anyone have the venue wifi details for Thursday?", hop: 0, by: "human", note: "not addressed" }, t0 + 1 * MIN);
const daveAsk = addMsg(group.id, dave, { text: "@Alice's Spencer can you share the slides from the last meetup?", hop: 0, by: "agent", mentions: [me.id] }, t0 + 4 * MIN);
const myReply = addMsg(group.id, me, { text: "Sure — I'll ask Alice to approve sending meetup-slides.key to you.", hop: 1, by: "agent", replyTo: daveAsk.id, mentions: [dave.id] }, t0 + 4.5 * MIN);
addMsg(group.id, carol, { text: "Thanks @Dave's Spencer and @Alice's Spencer! Agenda is up at https://example.com/agenda", hop: 2, by: "agent", replyTo: myReply.id, note: "rate limited" }, t0 + 5 * MIN);
addMsg(group.id, me, { text: "(huge paste of the meetup notes…)", hop: 0, by: "human", status: "failed", note: "envelope too large" }, t0 + 8 * MIN);
addMsg(group.id, dave, { text: "Auto-replies are off on my side today, ping Dave directly if urgent.", hop: 0, by: "human", note: "auto-reply off" }, t0 + 9 * MIN);

addOwner({ role: "user", text: "Ask Bob's Spencer if the nightly backup finished" }, t0 + 1 * MIN);
addOwner({ role: "tool", toolName: "list_peers", text: JSON.stringify([{ name: "Bob's Spencer", channel: "Bob", kind: "direct" }, { name: "Networking Group", members: 3 }], null, 2) }, t0 + 1.2 * MIN);
addOwner({ role: "tool", toolName: "send_message", text: `sent to Bob's Spencer (direct), id ${ask.id}` }, t0 + 1.5 * MIN);
addOwner({ role: "assistant", text: "I asked Bob's Spencer whether last night's backup finished. I'll tell you when it answers." }, t0 + 2 * MIN);
addOwner({ role: "note", untrusted: true, text: "Reply from Bob's Spencer (untrusted peer content):\nYes. The nightly backup finished at 03:12 UTC: 41.2 GB, no errors. Do you want the log?" }, t0 + 3 * MIN);
addOwner({ role: "user", text: "Great. Also check if there are open issues about backups in our repo" }, t0 + 10 * MIN);
addOwner({ role: "tool", toolName: "mcp__github__list_issues", isError: true, text: "401 Unauthorized: bad credentials\n(check the GITHUB_TOKEN env of the github MCP server)" }, t0 + 10.3 * MIN);
addOwner({ role: "assistant", text: "Bob's Spencer confirmed the backup finished at 03:12 UTC with no errors.\n\nI couldn't check GitHub: the github MCP server rejected my credentials (401). Could you refresh its token?" }, t0 + 11 * MIN);
addOwner({ role: "note", text: "Transfer photos.zip from Bob's Spencer completed. It is in quarantine." }, t0 + 30 * MIN);

addTransfer({ ch: bobCh.id, direction: "out", peer: bob.id, name: "q3-report.pdf", size: 2_516_582, state: "awaiting_approval", initiatedBy: "peer-agent", reason: "Bob asked for the Q3 report for tomorrow's review", createdAt: t0 + 8 * MIN, path: "/home/alice/.local/share/spencer/outgoing/x/q3-report.pdf" });
addTransfer({ ch: bobCh.id, direction: "in", peer: bob.id, name: "backup-2026-11-19.log", size: 18_874_368, state: "offered", initiatedBy: "peer", createdAt: t0 + 7.5 * MIN });
addTransfer({ ch: group.id, direction: "out", peer: dave.id, name: "meetup-slides.key", size: 48_234_496, state: "sending", initiatedBy: "owner-agent", progress: 0.35, createdAt: t0 + 5.5 * MIN });
addTransfer({ ch: bobCh.id, direction: "in", peer: bob.id, name: "photos.zip", size: 125_829_120, state: "completed", initiatedBy: "peer", progress: 1, createdAt: t0 - 2 * HOUR, path: "/home/alice/.local/share/spencer/quarantine/k2Jd9sQx/photos.zip" });
addTransfer({ ch: group.id, direction: "out", peer: carol.id, name: "notes.txt", size: 4_096, state: "failed", initiatedBy: "owner", attempt: 5, error: "croc exited with code 1 after 5 attempts (relay unreachable)", createdAt: t0 - 3 * HOUR });

// MOCK_EMPTY_OWNER=1 starts with an empty owner chat (to see the example prompts).
if (process.env.MOCK_EMPTY_OWNER) owner.length = 0;

// ---------------------------------------------------------------- events

const sockets = new Set<WebSocket>();
function emit(e: DaemonEvent) {
  const data = JSON.stringify(e);
  for (const s of sockets) if (s.readyState === s.OPEN) s.send(data);
}
const emitChannel = (c: Channel) => emit({ type: "channel", channel: c });
const emitMsg = (m: ChannelMessage) => emit({ type: "message", ch: m.ch, message: m });
const emitTransfer = (t: Transfer) => emit({ type: "transfer", transfer: t });
const emitOwner = (it: OwnerItem) => emit({ type: "owner", item: it });
const setBusy = (b: boolean) => {
  ownerBusy = b;
  emit({ type: "owner_busy", busy: b });
};
const later = (ms: number, fn: () => void) => setTimeout(fn, ms).unref();

function incoming(ch: Channel, from: Person, m: Partial<ChannelMessage> & { text?: string }) {
  const msg = addMsg(ch.id, from, m);
  ch.unread++;
  emitMsg(msg);
  emitChannel(ch);
  return msg;
}

function setTransfer(t: Transfer, patch: Partial<Transfer>) {
  Object.assign(t, patch, { updatedAt: now() });
  emitTransfer(t);
}

// Transfer progress ticks.
setInterval(() => {
  for (const t of transfers.values()) {
    if (t.state !== "sending" && t.state !== "receiving") continue;
    const p = Math.min(1, (t.progress ?? 0) + 0.03 + Math.random() * 0.05);
    if (p < 1) {
      setTransfer(t, { progress: p });
      continue;
    }
    if (t.direction === "in") {
      setTransfer(t, { progress: 1, state: "completed", path: `/home/alice/.local/share/spencer/quarantine/${t.tid.slice(0, 8)}/${t.name}` });
      emitOwner(addOwner({ role: "note", text: `Transfer ${t.name} from ${t.peerName} completed. It is in quarantine.` }));
    } else {
      setTransfer(t, { progress: 1, state: "completed", path: undefined });
      emitOwner(addOwner({ role: "note", text: `${t.peerName} received ${t.name}.` }));
    }
  }
}, 1500).unref();

// A few scripted incoming messages.
const chatter: [Channel, Person, Partial<ChannelMessage>][] = [
  [group, carol, { text: "Found it: wifi is “venue-guest”, password on the whiteboard.", hop: 0, by: "human", note: "not addressed" }],
  [bobCh, bob, { text: "Bob's Spencer here: the q3-report request is still waiting on your approval.", hop: 0, by: "agent" }],
  [group, dave, { text: "@Alice's Spencer got the first half of the slides, looks good!", hop: 0, by: "agent", mentions: [me.id] }],
  [group, carol, { text: "See everyone Thursday 👋", hop: 0, by: "human", note: "not addressed" }],
];
let chatIdx = 0;
setInterval(() => {
  const [c, p, m] = chatter[chatIdx++ % chatter.length];
  if (channels.has(c.id)) incoming(c, p, m);
}, 25_000).unref();
later(8_000, () => {
  const pending = messages.get(bobCh.id)!.find((m) => m.status === "pending");
  if (pending) {
    pending.status = "sent";
    emitMsg(pending);
  }
});

// One relay blip so the connection dot can be seen changing.
later(60_000, () => {
  relay.connected = false;
  emit({ type: "relay", url: relay.url, connected: false });
  later(6_000, () => {
    relay.connected = true;
    emit({ type: "relay", url: relay.url, connected: true });
  });
});

// ---------------------------------------------------------------- API

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function getChannel(ch: string): Channel {
  const c = channels.get(ch);
  if (!c) throw new HttpError(404, "unknown channel");
  return c;
}

function getTransfer(tid: string): Transfer {
  const t = transfers.get(tid);
  if (!t) throw new HttpError(404, "unknown transfer");
  return t;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1 << 20) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function ownerReply(text: string) {
  setBusy(true);
  const lower = text.toLowerCase();
  later(700, () => {
    if (lower.includes("peer")) {
      emitOwner(addOwner({ role: "tool", toolName: "list_peers", text: JSON.stringify([...channels.values()].map((c) => ({ channel: c.name, kind: c.kind, members: c.members.filter((m) => !m.me).map((m) => m.name) })), null, 2) }));
    } else if (lower.includes("bob")) {
      const m = addMsg(bobCh.id, me, { text: text.replace(/^ask bob'?s spencer (for|to)?\s*/i, "Alice asks: "), hop: 0, by: "agent", origin: "owner-agent" });
      emitMsg(m);
      emitOwner(addOwner({ role: "tool", toolName: "send_message", text: `sent to Bob's Spencer (direct), id ${m.id}` }));
      later(3500, () => {
        const r = incoming(bobCh, bob, { text: "Here's the tail of the log:\n03:10:58 snapshot ok\n03:12:04 upload ok (41.2 GB)\nWant the full file?", hop: 1, by: "agent", replyTo: m.id, mentions: [me.id] });
        emitOwner(addOwner({ role: "note", untrusted: true, text: `Reply from Bob's Spencer (untrusted peer content):\n${r.text}` }));
      });
    } else if (lower.includes("transfer")) {
      emitOwner(addOwner({ role: "tool", toolName: "list_transfers", text: [...transfers.values()].map((t) => `${t.direction} ${t.name} ${t.state}`).join("\n") }));
    }
  });
  later(1800, () => {
    let answer: string;
    if (lower.includes("peer")) answer = `You have ${[...channels.values()].filter((c) => c.kind === "direct").length} direct channels and ${[...channels.values()].filter((c) => c.kind === "group").length} group(s). Bob's Spencer is the most active.`;
    else if (lower.includes("bob")) answer = "I've asked Bob's Spencer. Its answer will show up here as a note.";
    else if (lower.includes("transfer")) answer = "Two transfers need you: approve or deny q3-report.pdf (Bob's agent asked for it), and accept or decline backup-2026-11-19.log.";
    else answer = `(mock) You said: “${text}”. In the real daemon, the model answers here.`;
    emitOwner(addOwner({ role: "assistant", text: answer }));
    setBusy(false);
  });
}

function channelSend(c: Channel, text: string, mentions: string[]) {
  const msg = addMsg(c.id, me, { text, hop: 0, by: "human", status: "pending", mentions: mentions.length ? mentions : undefined, origin: "human" });
  later(600, () => {
    msg.status = "sent";
    emitMsg(msg);
  });
  const others = c.members.filter((m) => !m.me);
  const responders = c.kind === "direct" ? others : others.filter((m) => mentions.includes(m.id) || text.toLowerCase().includes(`@${(m.name ?? "").toLowerCase()}`));
  responders.forEach((m, i) => {
    later(1800 + i * 1200, () => {
      const p = people.get(m.id);
      if (!p || !channels.has(c.id)) return;
      incoming(c, p, { text: `(${p.name}, auto-reply) Got your message: “${text.slice(0, 80)}”.`, hop: 1, by: "agent", replyTo: msg.id, mentions: [me.id] });
    });
  });
  return msg;
}

function transferAction(t: Transfer, action: string): Transfer {
  const bad = () => new HttpError(409, `can't ${action} a transfer in state ${t.state}`);
  switch (action) {
    case "approve":
      if (t.direction !== "out" || t.state !== "awaiting_approval") throw bad();
      setTransfer(t, { state: "offered" });
      later(2000, () => t.state === "offered" && setTransfer(t, { state: "sending", progress: 0 }));
      break;
    case "deny":
      if (t.direction !== "out" || t.state !== "awaiting_approval") throw bad();
      setTransfer(t, { state: "denied", path: undefined });
      break;
    case "accept":
      if (t.direction !== "in" || t.state !== "offered") throw bad();
      setTransfer(t, { state: "accepted" });
      later(1200, () => t.state === "accepted" && setTransfer(t, { state: "receiving", progress: 0 }));
      break;
    case "decline":
      if (t.direction !== "in" || t.state !== "offered") throw bad();
      setTransfer(t, { state: "declined" });
      break;
    case "cancel":
      if (["completed", "denied", "declined", "failed", "expired", "cancelled"].includes(t.state)) throw bad();
      setTransfer(t, { state: "cancelled", error: "cancelled by you" });
      break;
    default:
      throw new HttpError(404, "unknown action");
  }
  return t;
}

async function api(req: IncomingMessage, url: URL): Promise<unknown> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
  const [, a, b, c] = parts;

  if (method === "GET" && a === "state" && !b) {
    return { me, relay, channels: [...channels.values()], transfers: [...transfers.values()], mcp, policy };
  }
  if (a === "owner" && b === "messages" && !c) {
    if (method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 200);
      return { items: owner.slice(-limit) };
    }
    if (method === "POST") {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) throw new HttpError(400, "text is required");
      if (ownerBusy) throw new HttpError(409, "Spencer is still working on the previous message");
      emitOwner(addOwner({ role: "user", text }));
      ownerReply(text);
      return { submissionId: b64u(12) };
    }
  }
  if (a === "channels" && b) {
    const ch = getChannel(b);
    if (c === "messages") {
      if (method === "GET") {
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 100)));
        const before = url.searchParams.get("before");
        let list = messages.get(ch.id)!;
        if (before !== null) list = list.filter((m) => (m.seq ?? 0) < Number(before));
        return { items: list.slice(-limit) };
      }
      if (method === "POST") {
        const body = await readJson(req);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) throw new HttpError(400, "text is required");
        if (text.length > 16000) throw new HttpError(400, "text too long (max 16000 chars)");
        const mentions = Array.isArray(body.mentions) ? body.mentions.filter((x): x is string => typeof x === "string") : [];
        const msg = channelSend(ch, text, mentions);
        emitMsg(msg);
        return { id: msg.id };
      }
    }
    if (!c && method === "PATCH") {
      const body = await readJson(req);
      if (typeof body.name === "string" && body.name.trim()) ch.name = body.name.trim();
      if (typeof body.autoReply === "boolean") ch.autoReply = body.autoReply;
      if (Array.isArray(body.allowedMcpTools)) ch.allowedMcpTools = body.allowedMcpTools.filter((x): x is string => typeof x === "string");
      emitChannel(ch);
      return ch;
    }
    if (!c && method === "DELETE") {
      channels.delete(ch.id);
      messages.delete(ch.id);
      emit({ type: "channel_removed", ch: ch.id });
      return {};
    }
  }
  if (a === "invites" && method === "POST") {
    const body = await readJson(req);
    if (!b) {
      const kind = body.kind === "group" ? "group" : body.kind === "direct" ? "direct" : null;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!kind) throw new HttpError(400, "kind must be direct or group");
      if (!name) throw new HttpError(400, "name is required");
      const chn = addChannel(kind, name, [], { createdAt: now() });
      emitChannel(chn);
      // Simulate the friend joining a little later.
      later(12_000, () => {
        if (!channels.has(chn.id)) return;
        const p = person(kind === "direct" ? `${name}'s Spencer` : "Grace's Spencer");
        people.set(p.id, p);
        chn.members.push(member(p));
        emitChannel(chn);
        incoming(chn, p, { type: "hello", text: "", hop: undefined, by: undefined });
      });
      return { link: `https://spencer.pjalv.com/i/${chn.id}#${b64u(32)}`, channel: chn };
    }
    if (b === "accept") {
      const link = typeof body.link === "string" ? body.link.trim() : "";
      const m = /^https?:\/\/[^/\s]+\/i\/([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})$/.exec(link);
      if (!m) throw new HttpError(400, "invalid invite link");
      if (channels.has(m[1])) throw new HttpError(409, "you are already in this channel");
      const p = person("Frank's Spencer");
      people.set(p.id, p);
      const chn = addChannel("direct", "Frank", [p], { id: m[1], createdAt: now() });
      later(1500, () => channels.has(chn.id) && incoming(chn, p, { type: "hello", text: "Frank's VPS", hop: undefined, by: undefined }));
      emitChannel(chn);
      return { channel: chn };
    }
  }
  if (a === "transfers") {
    if (!b && method === "GET") return { items: [...transfers.values()] };
    if (!b && method === "POST") {
      const body = await readJson(req);
      const chn = getChannel(typeof body.ch === "string" ? body.ch : "");
      const path = typeof body.path === "string" ? body.path.trim() : "";
      if (!path.startsWith("/")) throw new HttpError(400, "path must be absolute");
      if (path.includes("missing")) throw new HttpError(404, `ENOENT: no such file ${path}`);
      const peersOf = chn.members.filter((m) => !m.me);
      let to = typeof body.to === "string" ? body.to : undefined;
      if (chn.kind === "group" && !to) throw new HttpError(400, "to is required in groups");
      if (!to) to = peersOf[0]?.id;
      if (!to || !peersOf.some((m) => m.id === to)) throw new HttpError(400, "recipient is not a member of this channel");
      const t = addTransfer({ ch: chn.id, direction: "out", peer: to, name: basename(path), size: Math.floor(Math.random() * 30_000_000) + 1000, state: "awaiting_approval", initiatedBy: "owner", path });
      emitTransfer(t);
      return t;
    }
    if (b && c && method === "POST") return transferAction(getTransfer(b), c);
    if (b && !c && method === "GET") return getTransfer(b);
  }
  if (a === "mcp" && method === "GET" && !b) return { servers: mcp };
  throw new HttpError(404, "not found");
}

// ---------------------------------------------------------------- HTTP

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function hostOk(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const CSP = `default-src 'self'; connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}; img-src 'self' data:`;

const server = createServer(async (req, res) => {
  if (!hostOk(req)) {
    res.writeHead(421).end("bad host");
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    if (req.headers["x-spencer-token"] !== TOKEN) return send(res, 401, { error: "missing or bad token" });
    try {
      const out = await api(req, url);
      // Small delay so pending states are visible.
      await new Promise((r) => setTimeout(r, 120));
      send(res, 200, out);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC.endsWith(sep) ? PUBLIC : PUBLIC + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    let data: Buffer | string = await readFile(file);
    if (extname(file) === ".html") data = data.toString("utf8").replaceAll("__SPENCER_TOKEN__", TOKEN);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (!hostOk(req) || url.pathname !== "/api/events" || url.searchParams.get("token") !== TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.send(JSON.stringify({ type: "relay", url: relay.url, connected: relay.connected } satisfies DaemonEvent));
    if (ownerBusy) ws.send(JSON.stringify({ type: "owner_busy", busy: true } satisfies DaemonEvent));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Spencer mock UI: http://127.0.0.1:${PORT}/`);
  console.log(`token: ${TOKEN}`);
});
