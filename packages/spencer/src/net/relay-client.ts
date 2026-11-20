import WebSocket from "ws";
import {
  MAX_FRAME_BYTES,
  RELAY_SERVER_NAME,
  relayAuthMessage,
  signText,
  type ClientFrame,
  type CrocInfo,
  type Identity,
  type ServerFrame,
} from "@spencer/protocol";

export class RelayError extends Error {
  readonly code: string;
  constructor(code: string, msg: string) {
    super(`${code}: ${msg}`);
    this.name = "RelayError";
    this.code = code;
  }
}

/** Codes after which resending the same envelope can never succeed. */
export const PERMANENT_SEND_ERRORS = new Set(["bad_request", "bad_sig", "too_large", "not_member", "no_channel", "limit"]);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RequestFrame = DistributiveOmit<Extract<ClientFrame, { rid: string }>, "rid">;
export type OkFrame = { t: "ok"; rid: string; [k: string]: unknown };

export interface RelayTuning {
  requestTimeoutMs: number;
  handshakeTimeoutMs: number;
  minBackoffMs: number;
  maxBackoffMs: number;
  /** Client-side liveness probe interval (relay also pings us at the WS level). */
  pingIntervalMs: number;
}

export const DEFAULT_RELAY_TUNING: RelayTuning = {
  requestTimeoutMs: 15_000,
  handshakeTimeoutMs: 15_000,
  minBackoffMs: 500,
  maxBackoffMs: 30_000,
  pingIntervalMs: 30_000,
};

export interface ConnectionHandlers {
  /** Authenticated (welcome received). */
  onReady(conn: RelayConnection): void;
  /** Was ready, now disconnected. */
  onDown(conn: RelayConnection): void;
  /** Unsolicited frames: msg, member, err without rid. */
  onFrame(conn: RelayConnection, frame: ServerFrame): void;
}

type ConnState = "idle" | "connecting" | "ready" | "closed";

interface Pending {
  resolve: (f: OkFrame) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** One authenticated, auto-reconnecting WebSocket to a relay. */
export class RelayConnection {
  readonly url: string;
  /** Challenge nonce of the current connection (needed for join/create proofs). */
  nonce: string | undefined;
  croc: CrocInfo | undefined;

  private state: ConnState = "idle";
  private ws: WebSocket | undefined;
  private identity: Identity;
  private handlers: ConnectionHandlers;
  private log: (m: string) => void;
  private tuning: RelayTuning;
  private pending = new Map<string, Pending>();
  private ridCounter = 0;
  private failures = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private readyWaiters = new Set<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closedPromise: Promise<void> | undefined;

  constructor(url: string, identity: Identity, handlers: ConnectionHandlers, log: (m: string) => void, tuning: RelayTuning) {
    this.url = url;
    this.identity = identity;
    this.handlers = handlers;
    this.log = log;
    this.tuning = tuning;
  }

  get ready(): boolean {
    return this.state === "ready";
  }

  start(): void {
    if (this.state !== "idle") return;
    this.connect();
  }

  private connect(): void {
    if (this.state === "closed") return;
    this.state = "connecting";
    this.nonce = undefined;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, { maxPayload: MAX_FRAME_BYTES, handshakeTimeout: this.tuning.handshakeTimeoutMs });
    } catch (e) {
      this.log(`relay ${this.url}: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.handshakeTimer = setTimeout(() => {
      this.log(`relay ${this.url}: handshake timeout`);
      ws.terminate();
    }, this.tuning.handshakeTimeoutMs);
    ws.on("message", (data, isBinary) => {
      if (this.ws !== ws || isBinary) return;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(data.toString()) as ServerFrame;
      } catch {
        this.log(`relay ${this.url}: unparseable frame`);
        return;
      }
      if (typeof frame !== "object" || frame === null || typeof frame.t !== "string") return;
      this.onFrame(ws, frame);
    });
    ws.on("error", (e) => {
      // Log the first failure of a streak and then every 10th, not every backoff cycle.
      if (this.ws === ws && this.failures % 10 === 0) this.log(`relay ${this.url}: ${e.message}`);
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.onClose();
    });
  }

  private onFrame(ws: WebSocket, f: ServerFrame): void {
    switch (f.t) {
      case "challenge": {
        if (f.server !== RELAY_SERVER_NAME) this.log(`relay ${this.url}: unexpected server ${String(f.server)}`);
        this.nonce = f.nonce;
        this.rawSend(ws, { t: "auth", id: this.identity.id, sig: signText(this.identity.secret, relayAuthMessage(f.nonce)) });
        return;
      }
      case "welcome": {
        if (f.id !== this.identity.id) {
          this.log(`relay ${this.url}: welcome for wrong id`);
          ws.terminate();
          return;
        }
        clearTimeout(this.handshakeTimer);
        if (f.croc) this.croc = f.croc;
        this.state = "ready";
        this.failures = 0;
        this.startPing();
        for (const w of this.readyWaiters) {
          clearTimeout(w.timer);
          w.resolve();
        }
        this.readyWaiters.clear();
        this.handlers.onReady(this);
        return;
      }
      case "ok":
      case "err": {
        const p = f.rid !== undefined ? this.pending.get(f.rid) : undefined;
        if (p) {
          this.pending.delete(f.rid!);
          clearTimeout(p.timer);
          if (f.t === "ok") p.resolve(f);
          else p.reject(new RelayError(f.code, f.msg));
          return;
        }
        if (f.t === "err") this.handlers.onFrame(this, f);
        return;
      }
      default:
        if (this.state === "ready") this.handlers.onFrame(this, f);
    }
  }

  private onClose(): void {
    const wasReady = this.state === "ready";
    this.ws = undefined;
    this.nonce = undefined;
    clearTimeout(this.handshakeTimer);
    clearInterval(this.pingTimer);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RelayError("disconnected", "connection closed"));
    }
    this.pending.clear();
    if (this.state === "closed") return;
    this.state = "connecting";
    if (wasReady) this.handlers.onDown(this);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.state === "closed") return;
    const base = Math.min(this.tuning.maxBackoffMs, this.tuning.minBackoffMs * 2 ** this.failures);
    this.failures++;
    const delay = Math.round(base / 2 + (Math.random() * base) / 2);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Reconnect now if waiting in backoff (e.g. a user action needs this relay). */
  nudge(): void {
    if (this.state === "connecting" && !this.ws && this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.connect();
    }
  }

  private startPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      this.request({ t: "ping" }).catch((e: Error) => {
        if (ws && this.ws === ws && (e as RelayError).code === "timeout") {
          this.log(`relay ${this.url}: ping timeout, reconnecting`);
          ws.terminate();
        }
      });
    }, this.tuning.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private rawSend(ws: WebSocket, frame: ClientFrame): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  whenReady(timeoutMs = this.tuning.requestTimeoutMs): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.state === "closed") return Promise.reject(new RelayError("closed", "relay client stopped"));
    this.nudge();
    return new Promise((resolve, reject) => {
      const w = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.readyWaiters.delete(w);
          reject(new RelayError("unreachable", `could not connect to relay ${this.url}`));
        }, timeoutMs),
      };
      this.readyWaiters.add(w);
    });
  }

  /** Request/response by rid. Rejects with RelayError (code from the relay, or disconnected/timeout). */
  request(frame: RequestFrame, timeoutMs = this.tuning.requestTimeoutMs): Promise<OkFrame> {
    const ws = this.ws;
    if (this.state !== "ready" || !ws) return Promise.reject(new RelayError("disconnected", "not connected"));
    const rid = `r${++this.ridCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new RelayError("timeout", `no reply to ${frame.t}`));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer });
      if (!this.rawSend(ws, { ...frame, rid } as ClientFrame)) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(new RelayError("disconnected", "not connected"));
      }
    });
  }

  /** Fire-and-forget frame (ack). Returns false when not connected. */
  send(frame: ClientFrame): boolean {
    if (this.state !== "ready" || !this.ws) return false;
    return this.rawSend(this.ws, frame);
  }

  close(): Promise<void> {
    if (this.closedPromise) return this.closedPromise;
    const wasReady = this.state === "ready";
    this.state = "closed";
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.handshakeTimer);
    clearInterval(this.pingTimer);
    for (const w of this.readyWaiters) {
      clearTimeout(w.timer);
      w.reject(new RelayError("closed", "relay client stopped"));
    }
    this.readyWaiters.clear();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RelayError("closed", "relay client stopped"));
    }
    this.pending.clear();
    const ws = this.ws;
    this.ws = undefined;
    if (wasReady) this.handlers.onDown(this);
    this.closedPromise = new Promise<void>((resolve) => {
      if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
      const t = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 1000);
      ws.once("close", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close(1000, "bye");
      } catch {
        ws.terminate();
      }
    });
    return this.closedPromise;
  }
}

export interface PoolHandlers {
  onReady(conn: RelayConnection): void;
  onDown(conn: RelayConnection): void;
  onFrame(conn: RelayConnection, frame: ServerFrame): void;
}

/** Connections keyed by relay URL (channels may live on different relays). */
export class RelayPool {
  private conns = new Map<string, RelayConnection>();
  private identity: Identity;
  private handlers: PoolHandlers;
  private log: (m: string) => void;
  private tuning: RelayTuning;
  private stopped = false;

  constructor(identity: Identity, handlers: PoolHandlers, log: (m: string) => void, tuning: Partial<RelayTuning> = {}) {
    this.identity = identity;
    this.handlers = handlers;
    this.log = log;
    this.tuning = { ...DEFAULT_RELAY_TUNING, ...tuning };
  }

  /** Returns (and lazily starts) the connection for `url`. */
  get(url: string): RelayConnection {
    if (this.stopped) throw new RelayError("closed", "relay client stopped");
    let c = this.conns.get(url);
    if (!c) {
      c = new RelayConnection(url, this.identity, this.handlers, this.log, this.tuning);
      this.conns.set(url, c);
      c.start();
    }
    return c;
  }

  peek(url: string): RelayConnection | undefined {
    return this.conns.get(url);
  }

  isConnected(url: string): boolean {
    return this.conns.get(url)?.ready ?? false;
  }

  urls(): string[] {
    return [...this.conns.keys()];
  }

  /** Close connections to relays no longer in `keep`. */
  async prune(keep: Set<string>): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [url, c] of this.conns) {
      if (!keep.has(url)) {
        this.conns.delete(url);
        closing.push(c.close());
      }
    }
    await Promise.all(closing);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const all = [...this.conns.values()];
    this.conns.clear();
    await Promise.all(all.map((c) => c.close()));
  }
}
