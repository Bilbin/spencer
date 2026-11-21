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
  /**
   * How often to compare the wall clock with the monotonic timer clock (0 = never). Node timers stop while the machine
   * sleeps, so after a resume a socket that died during the suspend would only be found by the next ping (up to
   * `pingIntervalMs` + `requestTimeoutMs` later). A wall-clock jump of more than `wakeJumpMs` beyond the check interval
   * means we were suspended: probe every connection right away.
   */
  wakeCheckMs: number;
  wakeJumpMs: number;
  /** Timeout of that probe ping. */
  probeTimeoutMs: number;
  /** Wall clock (tests). */
  now?: () => number;
}

export const DEFAULT_RELAY_TUNING: RelayTuning = {
  requestTimeoutMs: 15_000,
  handshakeTimeoutMs: 15_000,
  minBackoffMs: 500,
  maxBackoffMs: 30_000,
  pingIntervalMs: 30_000,
  wakeCheckMs: 5_000,
  wakeJumpMs: 10_000,
  probeTimeoutMs: 5_000,
};

/** What the API shows about one relay connection (PROTOCOL §8, `RelayStatus`). */
export interface RelayStatus {
  url: string;
  connected: boolean;
  /** connected: authenticated; connecting: a connection attempt is under way; waiting: in backoff until `retryAt`. */
  state: "connected" | "connecting" | "waiting";
  /** When `state` last changed (ms). */
  since: number;
  lastConnectedAt?: number;
  retryAt?: number;
  lastError?: string;
  /** Optional relay features from `welcome` (e.g. "presence", "ephemeral"); [] for older relays. */
  features: string[];
  stun?: string;
}

export interface ConnectionHandlers {
  /** Authenticated (welcome received). */
  onReady(conn: RelayConnection): void;
  /** `status()` changed (optional). */
  onState?(conn: RelayConnection): void;
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
  stun: string | undefined;
  /** Features the relay announced in its last `welcome`. */
  features: string[] = [];

  private state: ConnState = "idle";
  private phase: RelayStatus["state"] = "connecting";
  private since = Date.now();
  private lastConnectedAt: number | undefined;
  private retryAt: number | undefined;
  private lastError: string | undefined;
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

  status(): RelayStatus {
    return {
      url: this.url,
      connected: this.state === "ready",
      state: this.phase,
      since: this.since,
      ...(this.lastConnectedAt !== undefined ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.phase === "waiting" && this.retryAt !== undefined ? { retryAt: this.retryAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      features: [...this.features],
      ...(this.stun ? { stun: this.stun } : {}),
    };
  }

  private setPhase(phase: RelayStatus["state"]): void {
    if (this.state === "closed") return;
    const changed = phase !== this.phase;
    this.phase = phase;
    if (changed) this.since = Date.now();
    this.handlers.onState?.(this);
  }

  start(): void {
    if (this.state !== "idle") return;
    this.connect();
  }

  private connect(): void {
    if (this.state === "closed") return;
    this.state = "connecting";
    this.nonce = undefined;
    this.stun = undefined;
    this.setPhase("connecting");
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
      if (this.ws === ws) this.lastError = e.message;
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
        this.stun = typeof f.stun === "string" && f.stun.trim() ? f.stun : undefined;
        this.features = Array.isArray(f.features) ? f.features.filter((x): x is string => typeof x === "string").slice(0, 32) : [];
        this.state = "ready";
        this.failures = 0;
        this.lastConnectedAt = Date.now();
        this.lastError = undefined;
        this.setPhase("connected");
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
    this.stun = undefined;
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
    this.retryAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.setPhase("waiting");
  }

  /**
   * Check the connection now (after a suspected suspend): ping with a short timeout and replace the socket if it does
   * not answer; reconnect right away if waiting in backoff.
   */
  probe(): void {
    if (this.state === "ready") {
      const ws = this.ws;
      this.request({ t: "ping" }, this.tuning.probeTimeoutMs).catch((e: RelayError) => {
        if (ws && this.ws === ws && e.code === "timeout") {
          this.log(`relay ${this.url}: no answer after resume, reconnecting`);
          ws.terminate();
        }
      });
    } else {
      this.nudge();
    }
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
  onWake?(): void;
  onReady(conn: RelayConnection): void;
  onState?(conn: RelayConnection): void;
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
  private wakeTimer: NodeJS.Timeout | undefined;
  private lastTick = 0;

  constructor(identity: Identity, handlers: PoolHandlers, log: (m: string) => void, tuning: Partial<RelayTuning> = {}) {
    this.identity = identity;
    this.handlers = handlers;
    this.log = log;
    this.tuning = { ...DEFAULT_RELAY_TUNING, ...tuning };
    if (this.tuning.wakeCheckMs > 0) {
      const now = this.tuning.now ?? Date.now;
      this.lastTick = now();
      this.wakeTimer = setInterval(() => {
        const t = now();
        const gap = t - this.lastTick;
        this.lastTick = t;
        if (gap > this.tuning.wakeCheckMs + this.tuning.wakeJumpMs) {
          this.log(`clock jumped ${Math.round(gap / 1000)} s (resumed from sleep?); checking relay connections`);
          this.handlers.onWake?.();
          for (const c of this.conns.values()) c.probe();
        }
      }, this.tuning.wakeCheckMs);
      this.wakeTimer.unref?.();
    }
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

  status(url: string): RelayStatus | undefined {
    return this.conns.get(url)?.status();
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
    clearInterval(this.wakeTimer);
    const all = [...this.conns.values()];
    this.conns.clear();
    await Promise.all(all.map((c) => c.close()));
  }
}
