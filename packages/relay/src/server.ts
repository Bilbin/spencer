import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import {
  DIRECT_MAX_MEMBERS,
  MAX_ENVELOPE_BYTES,
  MAX_FRAME_BYTES,
  RELAY_SERVER_NAME,
  envelopeSize,
  isB64uId,
  isEnvelope,
  joinProofMessage,
  relayAuthMessage,
  verifyEnvelope,
  verifyText,
  type CrocInfo,
  type Envelope,
  type RelayErrorCode,
} from "@spencer/protocol";
import { RelayDb } from "./db.ts";
import { INVITE_PAGE_HEADERS, INVITE_PAGE_HTML, INVITE_PATH_RE } from "./invite-page.ts";

export interface RelayOptions {
  host?: string;
  port?: number;
  dbPath: string;
  ttlDays?: number;
  crocRelay?: string;
  crocPass?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface RelayHandle {
  port: number;
  url: string;
  httpUrl: string;
  close(): Promise<void>;
}

// ---- limits (PROTOCOL §4.3) ----
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const GC_INTERVAL_MS = 60_000;
const MAX_MESSAGES_PER_CHANNEL = 10_000;
const MAX_MEMBERSHIPS = 200;
/** Upper bound for a group's maxMembers (the protocol default is GROUP_MAX_MEMBERS = 32). */
const MAX_GROUP_MEMBERS = 256;
const SEND_BURST = 30;
const SEND_PER_SEC = 10;
/** Coarse guard for all other request frames (not in the protocol; generous on purpose). */
const FRAME_BURST = 400;
const FRAME_PER_SEC = 100;
const MAX_META_CHARS = 8192;
const MAX_RID_CHARS = 128;
const MAX_CONNECTIONS = 4096;
/** Backlog page size and backpressure thresholds. */
const BACKLOG_PAGE = 100;
const BACKLOG_HIGH_WATER = 1 << 20;
/** A live subscriber with more than this queued is dropped; it catches up with `sub` after reconnecting. */
const MAX_BUFFERED = 8 << 20;

class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly burst: number;
  private readonly rate: number;
  constructor(burst: number, perSec: number) {
    this.burst = burst;
    this.rate = perSec / 1000;
    this.tokens = burst;
    this.last = performance.now();
  }
  take(): boolean {
    const t = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + (t - this.last) * this.rate);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

interface Conn {
  ws: WebSocket;
  nonce: string;
  /** Authenticated identity id, or null before `welcome`. */
  id: string | null;
  alive: boolean;
  closed: boolean;
  subs: Set<string>;
  sendBucket: TokenBucket;
  frameBucket: TokenBucket;
  authTimer: NodeJS.Timeout | null;
}

class RequestError extends Error {
  readonly code: RelayErrorCode;
  constructor(code: RelayErrorCode, msg: string) {
    super(msg);
    this.code = code;
  }
}

function fail(code: RelayErrorCode, msg: string): never {
  throw new RequestError(code, msg);
}

const short = (id: string | null) => (id ? id.slice(0, 8) : "-");

export async function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  const host = opts.host ?? "127.0.0.1";
  const ttlMs = (opts.ttlDays ?? 14) * 86_400_000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const croc: CrocInfo | undefined = opts.crocRelay ? { relay: opts.crocRelay, pass: opts.crocPass ?? "" } : undefined;

  const db = new RelayDb(opts.dbPath);
  const conns = new Set<Conn>();
  /** identity id → its authenticated connections */
  const byId = new Map<string, Set<Conn>>();
  /** channel id → live subscribed connections */
  const subsByCh = new Map<string, Set<Conn>>();

  // ---------- helpers ----------

  const sendRaw = (c: Conn, data: string) => {
    if (c.closed || c.ws.readyState !== c.ws.OPEN) return;
    c.ws.send(data);
  };
  const sendFrame = (c: Conn, frame: object) => sendRaw(c, JSON.stringify(frame));
  const ok = (c: Conn, rid: string, body: object = {}) => sendFrame(c, { t: "ok", rid, ...body });
  const err = (c: Conn, rid: string | undefined, code: RelayErrorCode, msg: string) =>
    sendFrame(c, rid === undefined ? { t: "err", code, msg } : { t: "err", rid, code, msg });
  const msgFrame = (ch: string, seq: number, env: string) =>
    `{"t":"msg","ch":${JSON.stringify(ch)},"seq":${seq},"env":${env}}`;

  const subscribe = (c: Conn, ch: string) => {
    let set = subsByCh.get(ch);
    if (!set) subsByCh.set(ch, (set = new Set()));
    set.add(c);
    c.subs.add(ch);
  };
  const unsubscribe = (c: Conn, ch: string) => {
    const set = subsByCh.get(ch);
    if (set) {
      set.delete(c);
      if (set.size === 0) subsByCh.delete(ch);
    }
    c.subs.delete(ch);
  };

  /** Pushes a frame to every online connection of the channel's members except `exceptId`. */
  const pushToMembers = (ch: string, exceptId: string, data: string) => {
    for (const m of db.members(ch)) {
      if (m.id === exceptId) continue;
      for (const c of byId.get(m.id) ?? []) sendRaw(c, data);
    }
  };

  const expireNow = () => {
    const cutoff = now() - ttlMs;
    const n = db.expire(cutoff);
    if (n > 0) log(`gc: expired ${n} message(s)`);
  };

  const requireMember = (ch: string, id: string) => {
    if (!db.getChannel(ch)) fail("no_channel", "no such channel");
    const m = db.getMember(ch, id);
    if (!m) fail("not_member", "not a member of this channel");
    return m!;
  };

  const str = (v: unknown, name: string): string => (typeof v === "string" ? v : fail("bad_request", `${name} required`));
  const chId = (v: unknown): string => (isB64uId(v) ? v : fail("bad_request", "bad channel id"));

  // ---------- request handlers ----------

  function handleCreate(c: Conn, id: string, rid: string, f: Record<string, unknown>) {
    const ch = chId(f.ch);
    const kind = f.kind;
    if (kind !== "direct" && kind !== "group") fail("bad_request", "kind must be direct or group");
    const maxMembers = f.maxMembers;
    if (!Number.isSafeInteger(maxMembers)) fail("bad_request", "maxMembers required");
    const mm = maxMembers as number;
    if (kind === "direct" ? mm !== DIRECT_MAX_MEMBERS : mm < 2 || mm > MAX_GROUP_MEMBERS) {
      fail("bad_request", "maxMembers out of range");
    }
    const capPub = f.capPub;
    if (!isB64uId(capPub, 32)) fail("bad_request", "bad capPub");
    const meta = str(f.meta, "meta");
    if (meta.length === 0 || meta.length > MAX_META_CHARS || !/^[A-Za-z0-9_-]+$/.test(meta)) fail("bad_request", "bad meta");
    const proof = str(f.proof, "proof");
    if (!verifyText(capPub as string, joinProofMessage(ch, id, c.nonce), proof)) fail("bad_proof", "bad proof");

    const existing = db.getChannel(ch);
    if (existing) {
      if (existing.capPub !== capPub || !db.getMember(ch, id)) fail("bad_request", "channel already exists");
      log(`create (existing) ch=${short(ch)} id=${short(id)}`);
    } else {
      if (db.membershipCount(id) >= MAX_MEMBERSHIPS) fail("limit", "too many channel memberships");
      db.createChannel(
        { ch, kind: kind as "direct" | "group", maxMembers: mm, capPub: capPub as string, meta, createdAt: now() },
        id,
      );
      log(`create ch=${short(ch)} kind=${kind} id=${short(id)}`);
    }
    const chan = db.getChannel(ch)!;
    ok(c, rid, { head: chan.head, members: db.members(ch), ...(croc ? { croc } : {}) });
  }

  function handleJoin(c: Conn, id: string, rid: string, f: Record<string, unknown>) {
    const ch = chId(f.ch);
    const proof = str(f.proof, "proof");
    const chan = db.getChannel(ch) ?? fail("no_channel", "no such channel");
    if (!verifyText(chan.capPub, joinProofMessage(ch, id, c.nonce), proof)) fail("bad_proof", "bad proof");
    let joined = false;
    if (!db.getMember(ch, id)) {
      db.tx(() => {
        if (db.memberCount(ch) >= chan.maxMembers) fail("full", "channel is full");
        if (db.membershipCount(id) >= MAX_MEMBERSHIPS) fail("limit", "too many channel memberships");
        db.addMember(ch, id, now(), chan.head);
      });
      joined = true;
      log(`join ch=${short(ch)} id=${short(id)}`);
    }
    const members = db.members(ch);
    ok(c, rid, {
      kind: chan.kind,
      maxMembers: chan.maxMembers,
      meta: chan.meta,
      head: chan.head,
      members,
      ...(croc ? { croc } : {}),
    });
    if (joined) pushToMembers(ch, id, JSON.stringify({ t: "member", ch, id, event: "joined" }));
  }

  function handleLeave(c: Conn, id: string, rid: string, f: Record<string, unknown>) {
    const ch = chId(f.ch);
    requireMember(ch, id);
    db.removeMember(ch, id);
    for (const other of byId.get(id) ?? []) unsubscribe(other, ch);
    log(`leave ch=${short(ch)} id=${short(id)}`);
    ok(c, rid);
    pushToMembers(ch, id, JSON.stringify({ t: "member", ch, id, event: "left" }));
  }

  function handleMembers(c: Conn, id: string, rid: string, f: Record<string, unknown>) {
    const ch = chId(f.ch);
    requireMember(ch, id);
    ok(c, rid, { members: db.members(ch) });
  }

  function handleSend(c: Conn, id: string, rid: string, f: Record<string, unknown>) {
    if (!c.sendBucket.take()) fail("rate_limited", "too many sends");
    const raw = f.env;
    if (!isEnvelope(raw)) fail("bad_request", "malformed envelope");
    const e = raw as Envelope;
    // Store a canonical copy: only the protocol fields, in a fixed order.
    const env: Envelope = { v: 1, id: e.id, ch: e.ch, from: e.from, ts: e.ts, n: e.n, ct: e.ct, sig: e.sig };
    if (env.from !== id) fail("bad_sig", "env.from is not the authenticated identity");
    requireMember(env.ch, id);
    if (envelopeSize(env) > MAX_ENVELOPE_BYTES) fail("too_large", "envelope exceeds 64 KiB");
    if (!verifyEnvelope(env)) fail("bad_sig", "bad envelope signature");

    const dup = db.getSeen(env.ch, env.id);
    if (dup) {
      if (dup.sender !== id) fail("bad_request", "duplicate message id");
      ok(c, rid, { id: env.id, seq: dup.seq });
      return;
    }
    expireNow();
    if (db.messageCount(env.ch) >= MAX_MESSAGES_PER_CHANNEL) {
      db.gcChannel(env.ch);
      if (db.messageCount(env.ch) >= MAX_MESSAGES_PER_CHANNEL) fail("limit", "channel mailbox is full");
    }
    const envJson = JSON.stringify(env);
    const seq = db.appendMessage(env.ch, env.id, id, now(), envJson);
    ok(c, rid, { id: env.id, seq });

    const frame = msgFrame(env.ch, seq, envJson);
    for (const s of subsByCh.get(env.ch) ?? []) {
      if (s.id === id) continue;
      sendRaw(s, frame);
      if (s.ws.bufferedAmount > MAX_BUFFERED) {
        log(`drop slow consumer id=${short(s.id)}`);
        s.ws.terminate();
      }
    }
    // A message nobody else needs (e.g. sender is the only member) is dropped right away.
    db.gcChannel(env.ch);
  }

  async function handleSub(c: Conn, id: string, rid: string, f: Record<string, unknown>) {
    const ch = chId(f.ch);
    const since = f.since;
    if (!Number.isSafeInteger(since) || (since as number) < 0) fail("bad_request", "since must be a non-negative integer");
    const member = requireMember(ch, id);
    expireNow();
    // Re-subscribing: stop live pushes until the backlog is streamed so order is preserved.
    unsubscribe(c, ch);
    let after = Math.max(since as number, member.joinSeq);
    for (;;) {
      if (c.closed) return;
      if (!db.getMember(ch, id)) return err(c, rid, "not_member", "not a member of this channel");
      const rows = db.backlog(ch, after, id, BACKLOG_PAGE);
      if (rows.length === 0) break;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        after = r.seq;
        const data = msgFrame(ch, r.seq, r.env);
        if (i === rows.length - 1 && c.ws.bufferedAmount > BACKLOG_HIGH_WATER) {
          // Backpressure: wait until this page has been written to the socket.
          await new Promise<void>((resolve) => {
            if (c.closed || c.ws.readyState !== c.ws.OPEN) return resolve();
            c.ws.send(data, () => resolve());
          });
        } else {
          sendRaw(c, data);
        }
      }
    }
    // No await between the last (empty) page and going live, so nothing can slip through.
    const chan = db.getChannel(ch)!;
    // `first`: messages with seq < first that this member needed may have been lost to TTL expiry.
    // Messages removed because everyone acked them, or that predate this member's join, never
    // count as lost (see the report / PROTOCOL note on `first`).
    const first = chan.expiredThrough > member.joinSeq ? chan.expiredThrough + 1 : 1;
    ok(c, rid, { head: chan.head, first, members: db.members(ch) });
    subscribe(c, ch);
  }

  function handleAck(id: string, f: Record<string, unknown>) {
    if (!isB64uId(f.ch) || !Number.isSafeInteger(f.seq) || (f.seq as number) < 0) return;
    const ch = f.ch as string;
    if (db.ack(ch, id, f.seq as number)) db.gcChannel(ch);
  }

  // ---------- frame dispatch ----------

  function handleAuth(c: Conn, f: Record<string, unknown>) {
    const id = f.id;
    const sig = f.sig;
    if (!isB64uId(id, 32) || typeof sig !== "string") {
      err(c, undefined, "bad_request", "auth needs id and sig");
      c.ws.close(1008, "bad auth");
      return;
    }
    if (!verifyText(id, relayAuthMessage(c.nonce), sig)) {
      err(c, undefined, "bad_sig", "bad auth signature");
      log(`auth failed id=${short(id)}`);
      c.ws.close(1008, "bad auth");
      return;
    }
    c.id = id;
    if (c.authTimer) clearTimeout(c.authTimer);
    c.authTimer = null;
    let set = byId.get(id);
    if (!set) byId.set(id, (set = new Set()));
    set.add(c);
    const welcome: Record<string, unknown> = { t: "welcome", id };
    if (croc && db.hasAnyMembership(id)) welcome.croc = croc;
    sendFrame(c, welcome);
    log(`auth id=${short(id)} conns=${conns.size}`);
  }

  function onMessage(c: Conn, data: RawData, isBinary: boolean) {
    let f: Record<string, unknown>;
    try {
      if (isBinary) throw new Error("binary");
      const parsed: unknown = JSON.parse(String(data));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      f = parsed as Record<string, unknown>;
    } catch {
      err(c, undefined, "bad_request", "frames must be JSON objects");
      return;
    }
    const rawRid = f.rid;
    const rid = typeof rawRid === "string" && rawRid.length <= MAX_RID_CHARS ? rawRid : undefined;

    if (c.id === null) {
      if (f.t === "auth") return handleAuth(c, f);
      return err(c, rid, "unauthenticated", "authenticate first");
    }
    const id = c.id;
    if (f.t === "ack") return handleAck(id, f);
    if (f.t !== "send" && !c.frameBucket.take()) return err(c, rid, "rate_limited", "too many requests");
    if (rid === undefined) return err(c, undefined, "bad_request", "rid must be a string");

    try {
      switch (f.t) {
        case "create":
          return handleCreate(c, id, rid, f);
        case "join":
          return handleJoin(c, id, rid, f);
        case "leave":
          return handleLeave(c, id, rid, f);
        case "members":
          return handleMembers(c, id, rid, f);
        case "send":
          return handleSend(c, id, rid, f);
        case "sub":
          handleSub(c, id, rid, f).catch((e) => onHandlerError(c, rid, e));
          return;
        case "ping":
          return ok(c, rid);
        case "auth":
          return err(c, rid, "bad_request", "already authenticated");
        default:
          return err(c, rid, "bad_request", "unknown frame type");
      }
    } catch (e) {
      onHandlerError(c, rid, e);
    }
  }

  function onHandlerError(c: Conn, rid: string, e: unknown) {
    if (e instanceof RequestError) return err(c, rid, e.code, e.message);
    log(`error id=${short(c.id)}: ${e instanceof Error ? e.message : String(e)}`);
    err(c, rid, "bad_request", "internal error");
  }

  // ---------- websocket lifecycle ----------

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });

  wss.on("connection", (ws: WebSocket) => {
    const c: Conn = {
      ws,
      nonce: randomBytes(32).toString("base64url"),
      id: null,
      alive: true,
      closed: false,
      subs: new Set(),
      sendBucket: new TokenBucket(SEND_BURST, SEND_PER_SEC),
      frameBucket: new TokenBucket(FRAME_BURST, FRAME_PER_SEC),
      authTimer: null,
    };
    conns.add(c);
    c.authTimer = setTimeout(() => {
      c.authTimer = null;
      if (c.id === null) c.ws.close(1008, "auth timeout");
    }, AUTH_TIMEOUT_MS);
    ws.on("pong", () => {
      c.alive = true;
    });
    ws.on("message", (data, isBinary) => onMessage(c, data, isBinary));
    ws.on("error", (e) => log(`ws error id=${short(c.id)}: ${e.message}`));
    ws.on("close", () => {
      c.closed = true;
      if (c.authTimer) clearTimeout(c.authTimer);
      conns.delete(c);
      for (const ch of [...c.subs]) unsubscribe(c, ch);
      if (c.id) {
        const set = byId.get(c.id);
        set?.delete(c);
        if (set && set.size === 0) byId.delete(c.id);
      }
    });
    sendFrame(c, { t: "challenge", nonce: c.nonce, server: RELAY_SERVER_NAME });
  });

  const heartbeat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        log(`drop dead connection id=${short(c.id)}`);
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        c.ws.terminate();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const gcTimer = setInterval(() => {
    try {
      expireNow();
      db.pruneSeen(now() - ttlMs);
    } catch (e) {
      log(`gc error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, GC_INTERVAL_MS);
  gcTimer.unref();

  // ---------- http ----------

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    const isGet = req.method === "GET" || req.method === "HEAD";
    const send = (status: number, headers: Record<string, string>, body: string) => {
      res.writeHead(status, { "content-length": String(Buffer.byteLength(body)), ...headers });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const text = (status: number, body: string) =>
      send(status, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" }, body);
    if (path === "/healthz" && isGet) return text(200, "ok");
    if (INVITE_PATH_RE.test(path) && isGet) return send(200, INVITE_PAGE_HEADERS, INVITE_PAGE_HTML);
    if (path === "/ws") return text(426, "websocket upgrade required");
    text(404, "not found");
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/ws" || conns.size >= MAX_CONNECTIONS) {
      const status = path !== "/ws" ? "404 Not Found" : "503 Service Unavailable";
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (e) => log(`http error: ${e.message}`));

  const port = (server.address() as AddressInfo).port;
  const hostForUrl = host.includes(":") ? `[${host}]` : host;
  let closing: Promise<void> | null = null;

  return {
    port,
    url: `ws://${hostForUrl}:${port}/ws`,
    httpUrl: `http://${hostForUrl}:${port}`,
    close() {
      closing ??= (async () => {
        clearInterval(heartbeat);
        clearInterval(gcTimer);
        for (const c of conns) {
          if (c.authTimer) clearTimeout(c.authTimer);
          c.ws.terminate();
        }
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        db.close();
      })();
      return closing;
    },
  };
}
