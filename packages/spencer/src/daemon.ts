import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  MAX_CHAT_TEXT,
  fingerprint,
  isB64uId,
  pairKey,
  type Body,
  type ChatBody,
  type CrocInfo,
  type Identity,
  type ServerFrame,
} from "@spencer/protocol";
import { loadConfig, resolveConfig, type SpencerConfig } from "./config.ts";
import type {
  AgentService,
  Channel,
  CoreServices,
  IncomingChat,
  MessageOrigin,
  TransferDeps,
  TransferService,
} from "./contracts.ts";
import { EventBus } from "./events.ts";
import { openDb, Sql } from "./store/db.ts";
import { acquireLock, type DataDirLock } from "./store/lock.ts";
import { loadOrCreateIdentity, loadOrCreateToken } from "./store/files.ts";
import { RelayPool, type RelayConnection, type RelayTuning } from "./net/relay-client.ts";
import { Outbox } from "./net/outbox.ts";
import { Inbox, type StoredMessage } from "./net/inbox.ts";
import { ChannelManager, UserError } from "./channels.ts";
import { ApiServer } from "./api/http.ts";

export interface DaemonTuning {
  relay?: Partial<RelayTuning>;
  outboxMinBackoffMs?: number;
  outboxMaxBackoffMs?: number;
  inboxRetryMs?: number;
}

export interface DaemonOptions {
  dataDir: string;
  /** Merged over `<dataDir>/config.json` (via resolveConfig). */
  config?: Partial<SpencerConfig>;
  agentFactory?: (core: CoreServices) => AgentService | Promise<AgentService>;
  transferFactory?: (deps: TransferDeps) => TransferService | Promise<TransferService>;
  log?: (msg: string) => void;
  /** Static UI dir. Default: `@spencer/web` webRoot if installed. `null` = placeholder page. */
  webRoot?: string | null;
  tuning?: DaemonTuning;
}

async function defaultAgentFactory(core: CoreServices): Promise<AgentService> {
  const spec = new URL("./agent/index.ts", import.meta.url).href;
  const mod = (await import(spec)) as { createAgent(core: CoreServices): AgentService | Promise<AgentService> };
  return mod.createAgent(core);
}

async function defaultTransferFactory(deps: TransferDeps): Promise<TransferService> {
  const spec = new URL("./transfers/index.ts", import.meta.url).href;
  const mod = (await import(spec)) as { createTransferService(deps: TransferDeps): TransferService | Promise<TransferService> };
  return mod.createTransferService(deps);
}

async function defaultWebRoot(log: (m: string) => void): Promise<string | undefined> {
  const spec = "@spencer/web";
  try {
    const mod = (await import(spec)) as { webRoot?: unknown };
    if (typeof mod.webRoot === "string" && existsSync(mod.webRoot)) return mod.webRoot;
  } catch {
    /* not installed yet */
  }
  log("web UI not found; serving a placeholder page");
  return undefined;
}

/** `<dataDir>/config.json` (created with defaults if missing) with `override` merged over it. */
export function loadMergedConfig(dataDir: string, override: Partial<SpencerConfig> = {}): SpencerConfig {
  const file = join(dataDir, "config.json");
  if (!existsSync(file)) loadConfig(dataDir);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<SpencerConfig> & Record<string, unknown>;
  const merged = {
    ...raw,
    ...override,
    http: { ...(raw.http ?? {}), ...(override.http ?? {}) },
    croc: { ...(raw.croc ?? {}), ...(override.croc ?? {}) },
    policy: { ...(raw.policy ?? {}), ...(override.policy ?? {}) },
  } as Partial<SpencerConfig> & Record<string, unknown>;
  return resolveConfig(merged);
}

type Started = {
  lock: DataDirLock;
  cfg: SpencerConfig;
  db: DatabaseSync;
  sql: Sql;
  me: Identity;
  token: string;
  pool: RelayPool;
  channels: ChannelManager;
  outbox: Outbox;
  inbox: Inbox;
  core: CoreServices;
  transfers?: TransferService;
  agent?: AgentService;
  api?: ApiServer;
};

export class Daemon {
  readonly dataDir: string;
  readonly events: EventBus;
  private opts: DaemonOptions;
  private log: (m: string) => void;
  private s: Partial<Started> = {};
  private state: "new" | "starting" | "running" | "stopping" | "stopped" = "new";

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    this.dataDir = opts.dataDir;
    this.log = opts.log ?? ((m: string) => console.error(`[spencer] ${m}`));
    this.events = new EventBus(this.log);
  }

  // ------------------------------------------------------------- accessors

  private need<K extends keyof Started>(k: K): NonNullable<Started[K]> {
    const v = this.s[k];
    if (v === undefined || v === null) throw new Error(`daemon not started (${String(k)})`);
    return v as NonNullable<Started[K]>;
  }

  get running(): boolean {
    return this.state === "running";
  }
  get port(): number {
    return this.need("api").port;
  }
  get token(): string {
    return this.need("token");
  }
  get identity(): { id: string; name: string; fingerprint: string } {
    const me = this.need("me");
    return { id: me.id, name: this.need("cfg").name, fingerprint: fingerprint(me.id) };
  }
  get config(): SpencerConfig {
    return this.need("cfg");
  }
  get core(): CoreServices {
    return this.need("core");
  }
  get db(): DatabaseSync {
    return this.need("db");
  }
  get channels(): ChannelManager {
    return this.need("channels");
  }
  get outbox(): Outbox {
    return this.need("outbox");
  }
  get agent(): AgentService {
    return this.need("agent");
  }
  get transfers(): TransferService {
    return this.need("transfers");
  }
  get pool(): RelayPool {
    return this.need("pool");
  }
  get url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  // ------------------------------------------------------------- convenience (tests, CLI)

  createInvite(kind: "direct" | "group", name: string): Promise<{ link: string; channel: Channel }> {
    return this.channels.createInvite(kind, name);
  }
  acceptInvite(link: string): Promise<Channel> {
    return this.channels.acceptInvite(link);
  }
  /** Owner speaks in a channel (hop 0, by human). */
  sendHuman(ch: string, text: string, mentions?: string[]): { id: string } {
    return this.core.sendChat(ch, { text, hop: 0, by: "human", origin: "human", ...(mentions ? { mentions } : {}) });
  }
  leave(ch: string): Promise<void> {
    return this.channels.leave(ch);
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.state !== "new" && this.state !== "stopped") throw new Error(`cannot start a ${this.state} daemon`);
    this.state = "starting";
    this.s = {};
    try {
      await this.doStart();
      this.state = "running";
    } catch (e) {
      await this.teardown();
      this.state = "stopped";
      throw e;
    }
  }

  private async doStart(): Promise<void> {
    const dir = this.dataDir;
    const log = this.log;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
    const s = this.s;
    s.lock = acquireLock(dir);
    const cfg = (s.cfg = loadMergedConfig(dir, this.opts.config));
    s.db = openDb(dir);
    const sql = (s.sql = new Sql(s.db));
    const me = (s.me = loadOrCreateIdentity(dir));
    s.token = loadOrCreateToken(dir);
    const tuning = this.opts.tuning ?? {};

    const channelChanged = (ch: string) => {
      const a = this.s.agent;
      if (a) a.channelChanged(ch).catch((e: Error) => log(`agent.channelChanged(${ch}): ${e.message}`));
    };

    s.pool = new RelayPool(
      me,
      {
        onReady: (conn) => this.onRelayReady(conn),
        onDown: (conn) => this.events.emit({ type: "relay", url: conn.url, connected: false }),
        onFrame: (conn, f) => this.onRelayFrame(conn, f),
      },
      log,
      tuning.relay,
    );
    const channels = (s.channels = new ChannelManager({
      sql,
      me,
      config: () => this.need("cfg"),
      pool: () => this.need("pool"),
      outbox: () => this.need("outbox"),
      events: this.events,
      log,
      channelChanged,
    }));
    s.outbox = new Outbox({
      sql,
      me,
      log,
      channelInfo: (ch) => channels.info(ch),
      connection: (url) => this.s.pool?.peek(url),
      messageChanged: (id) => {
        const m = channels.message(id);
        if (m) this.events.emit({ type: "message", ch: m.ch, message: m });
      },
      ...(tuning.outboxMinBackoffMs !== undefined ? { minBackoffMs: tuning.outboxMinBackoffMs } : {}),
      ...(tuning.outboxMaxBackoffMs !== undefined ? { maxBackoffMs: tuning.outboxMaxBackoffMs } : {}),
    });
    s.inbox = new Inbox({
      sql,
      me,
      log,
      channelInfo: (ch) => channels.info(ch),
      route: (msg, body) => this.route(msg, body),
      routed: (msg, body) => {
        if (body.type === "chat" || body.type === "hello") {
          const m = channels.message(msg.id);
          if (m) this.events.emit({ type: "message", ch: msg.ch, message: m });
          if (body.type === "chat") channels.emitChannel(msg.ch); // unread changed
        }
      },
      ack: (url, ch, seq) => {
        this.s.pool?.peek(url)?.send({ t: "ack", ch, seq });
      },
      ...(tuning.inboxRetryMs !== undefined ? { retryMs: tuning.inboxRetryMs } : {}),
    });
    s.core = this.buildCore();

    const tdeps = this.buildTransferDeps();
    s.transfers = await (this.opts.transferFactory ?? defaultTransferFactory)(tdeps);
    await s.transfers.start();
    s.agent = await (this.opts.agentFactory ?? defaultAgentFactory)(s.core);
    await s.agent.start();

    await s.inbox.rerouteUnrouted();

    for (const url of channels.relayUrls()) s.pool.get(url);
    s.outbox.kick();

    const webRoot = this.opts.webRoot === null ? undefined : (this.opts.webRoot ?? (await defaultWebRoot(log)));
    s.api = new ApiServer({
      token: s.token,
      log,
      events: this.events,
      core: s.core,
      agent: () => this.need("agent"),
      transfers: () => this.need("transfers"),
      state: () => this.apiState(),
      channelMessages: (ch, limit, before) => {
        const items = channels.messages(ch, limit, before, ["chat", "hello"]);
        if (!before) channels.markRead(ch);
        return items;
      },
      updateChannel: (ch, patch) => channels.update(ch, patch),
      leaveChannel: (ch) => channels.leave(ch),
      acceptInvite: (link) => channels.acceptInvite(link),
      ...(webRoot ? { webRoot } : {}),
    });
    await s.api.listen(cfg.http.port);
  }

  async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "new") return;
    if (this.state === "stopping") throw new Error("already stopping");
    this.state = "stopping";
    await this.teardown();
    this.state = "stopped";
  }

  /** Reverse of start; tolerant of partially started state. */
  private async teardown(): Promise<void> {
    const s = this.s;
    const step = async (name: string, fn: () => unknown) => {
      try {
        await fn();
      } catch (e) {
        this.log(`stop ${name}: ${(e as Error).message}`);
      }
    };
    if (s.api) await step("api", () => s.api!.close());
    if (s.pool) await step("relays", () => s.pool!.stop());
    if (s.outbox) await step("outbox", () => s.outbox!.stop());
    if (s.inbox) await step("inbox", () => s.inbox!.stop());
    if (s.agent) await step("agent", () => s.agent!.stop());
    if (s.transfers) await step("transfers", () => s.transfers!.stop());
    if (s.db) await step("db", () => s.db!.close());
    if (s.lock) await step("lock", () => s.lock!.release());
    this.s = {};
  }

  // ------------------------------------------------------------- relay events

  private onRelayReady(conn: RelayConnection): void {
    const channels = this.need("channels");
    channels.setCroc(conn.url, conn.croc);
    this.events.emit({ type: "relay", url: conn.url, connected: true });
    const chs = channels.channelsOnRelay(conn.url);
    void Promise.allSettled(chs.map((ch) => channels.subscribe(conn, ch))).then(() => {
      const outbox = this.s.outbox;
      if (outbox) for (const ch of chs) outbox.kick(ch);
    });
  }

  private onRelayFrame(conn: RelayConnection, f: ServerFrame): void {
    switch (f.t) {
      case "msg":
        this.s.inbox?.onMsg(conn.url, f);
        return;
      case "member": {
        const channels = this.s.channels;
        const row = channels?.row(f.ch);
        if (channels && row && row.relay_url === conn.url) channels.onMemberEvent(f.ch, f.id, f.event);
        return;
      }
      case "err":
        this.log(`relay ${conn.url}: ${f.code}: ${f.msg}`);
        return;
    }
  }

  // ------------------------------------------------------------- routing

  private async route(msg: StoredMessage, body: Body): Promise<void> {
    const channels = this.need("channels");
    switch (body.type) {
      case "hello":
        channels.onHello(msg.ch, msg.from_id, body);
        return;
      case "chat":
        await this.routeChat(msg, body);
        return;
      default:
        if (body.to === this.need("me").id) await this.need("transfers").onBody(msg.ch, msg.from_id, body);
    }
  }

  private async routeChat(msg: StoredMessage, body: ChatBody): Promise<void> {
    const channels = this.need("channels");
    const sql = this.need("sql");
    const row = channels.row(msg.ch);
    if (!row) return;
    const incoming: IncomingChat = {
      id: msg.id,
      ch: msg.ch,
      seq: msg.seq ?? 0,
      from: msg.from_id,
      ts: msg.ts,
      body,
      channelKind: row.kind,
      channelName: channels.displayName(row),
    };
    const fromName = channels.peerName(msg.ch, msg.from_id);
    if (fromName) incoming.fromName = fromName;
    if (body.replyTo) {
      const orig = sql.get<{ origin: string | null; body: string }>(
        "SELECT origin, body FROM messages WHERE id = ? AND ch = ? AND mine = 1",
        body.replyTo,
        msg.ch,
      );
      if (orig) {
        if (orig.origin) incoming.replyToOrigin = orig.origin as MessageOrigin;
        try {
          const t = (JSON.parse(orig.body) as { text?: unknown }).text;
          if (typeof t === "string") incoming.replyToText = t;
        } catch {
          /* ignore */
        }
      }
    }
    const res = await this.need("agent").onPeerChat(incoming);
    sql.run("UPDATE messages SET note = ? WHERE id = ?", res?.note ?? null, msg.id);
  }

  // ------------------------------------------------------------- services

  private buildCore(): CoreServices {
    const channels = this.need("channels");
    const outbox = this.need("outbox");
    const log = this.log;
    const daemon = this;
    return {
      db: this.need("db"),
      dataDir: this.dataDir,
      config: () => this.need("cfg"),
      me: () => this.identity,
      listChannels: () => channels.list(),
      getChannel: (ch) => channels.get(ch),
      readChannel: (ch, limit) => channels.messages(ch, limit),
      sendChat(ch, msg) {
        if (!channels.row(ch)) throw new UserError(404, `unknown channel ${ch}`);
        if (typeof msg.text !== "string" || msg.text.length === 0) throw new UserError(400, "text is required");
        if (msg.text.length > MAX_CHAT_TEXT) throw new UserError(400, `text too long (max ${MAX_CHAT_TEXT} chars)`);
        if (!Number.isSafeInteger(msg.hop) || msg.hop < 0) throw new UserError(400, "hop must be a non-negative integer");
        if (msg.by !== "human" && msg.by !== "agent") throw new UserError(400, "by must be human or agent");
        if (msg.replyTo !== undefined && !isB64uId(msg.replyTo)) throw new UserError(400, "invalid replyTo");
        if (msg.mentions !== undefined && (msg.mentions.length > 64 || !msg.mentions.every((m) => isB64uId(m, 32)))) {
          throw new UserError(400, "invalid mentions");
        }
        const body: ChatBody = { type: "chat", text: msg.text, hop: msg.hop, by: msg.by };
        if (msg.replyTo !== undefined) body.replyTo = msg.replyTo;
        if (msg.mentions !== undefined && msg.mentions.length > 0) body.mentions = [...new Set(msg.mentions)];
        const res = outbox.enqueue(ch, body, {
          origin: msg.origin,
          ...(msg.idempotencyKey !== undefined ? { idempotencyKey: msg.idempotencyKey } : {}),
        });
        if (res.created && (msg.origin === "human" || msg.origin === "owner-agent")) {
          const agent = daemon.s.agent;
          if (agent) {
            const ts = Date.now();
            queueMicrotask(() => {
              agent
                .onOutgoingChat({ id: res.id, ch, text: msg.text, origin: msg.origin, ts })
                .catch((e: Error) => log(`agent.onOutgoingChat: ${e.message}`));
            });
          }
        }
        return { id: res.id };
      },
      requestFileSend: (ch, req) => this.need("transfers").request(ch, req),
      listTransfers: (ch) => this.need("transfers").list(ch),
      createInvite: (kind, name) => channels.createInvite(kind, name),
      events: this.events,
    };
  }

  private buildTransferDeps(): TransferDeps {
    const channels = this.need("channels");
    const outbox = this.need("outbox");
    const me = this.need("me");
    return {
      db: this.need("db"),
      dataDir: this.dataDir,
      me,
      policy: () => this.need("cfg").policy,
      enqueue: (ch, body) => {
        outbox.enqueue(ch, body);
      },
      crocInfo: (ch): CrocInfo | undefined => {
        const c = this.need("cfg").croc;
        const fromRelay = channels.crocFor(ch);
        const relay = c.relay ?? fromRelay?.relay;
        const pass = c.pass ?? fromRelay?.pass;
        return relay && pass ? { relay, pass } : undefined;
      },
      pairKey: (ch, peerId) => pairKey(me.secret, peerId, me.id, ch),
      peers: (ch) => channels.peers(ch),
      peerName: (ch, peerId) => channels.peerName(ch, peerId),
      crocPath: this.need("cfg").croc.path,
      ...(this.need("cfg").croc.throttleUpload ? { crocThrottleUpload: this.need("cfg").croc.throttleUpload! } : {}),
      events: this.events,
      log: this.log,
      ownerNote: (text) => {
        const a = this.s.agent;
        if (!a) {
          this.log(`owner note (agent not ready): ${text}`);
          return;
        }
        a.ownerNote(text).catch((e: Error) => this.log(`agent.ownerNote: ${e.message}`));
      },
    };
  }

  apiState(): unknown {
    const cfg = this.need("cfg");
    const pool = this.need("pool");
    const channels = this.need("channels");
    const urls = new Set(channels.relayUrls());
    if (pool.peek(cfg.relay)) urls.add(cfg.relay);
    const relays = [...urls].map((url) => ({ url, connected: pool.isConnected(url) }));
    const agent = this.s.agent;
    return {
      me: this.identity,
      relay: { url: cfg.relay, connected: relays.length > 0 && relays.every((r) => r.connected) },
      relays,
      channels: channels.list(),
      transfers: this.s.transfers?.list() ?? [],
      mcp: agent?.mcpStatus() ?? [],
      policy: cfg.policy,
      ownerBusy: agent?.ownerBusy() ?? false,
    };
  }
}
