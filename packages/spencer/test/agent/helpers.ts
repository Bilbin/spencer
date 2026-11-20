/** Test helpers: an in-memory stub of `CoreServices` and small waiting utilities. */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultConfig, type SpencerConfig } from "../../src/config.ts";
import type {
  Channel,
  ChannelMessage,
  CoreServices,
  DaemonEvent,
  IncomingChat,
  MessageOrigin,
  Transfer,
  TransferRequest,
} from "../../src/contracts.ts";

export const ME = { id: "me-id-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", name: "Alice's Spencer", fingerprint: "aaaa-aaaa-aaaa-aaaa-aaaa" };
export const BOB = { id: "bob-id-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", name: "Bob's Spencer", fingerprint: "bbbb-bbbb-bbbb-bbbb-bbbb" };
export const CAROL = { id: "carol-id-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", name: "Carol's Spencer", fingerprint: "cccc-cccc-cccc-cccc-cccc" };

export interface SentChat {
  ch: string;
  id: string;
  text: string;
  hop: number;
  by: "human" | "agent";
  origin: MessageOrigin;
  replyTo?: string;
  mentions?: string[];
  idempotencyKey?: string;
}

export interface StubCore extends CoreServices {
  dir: string;
  /** Every enqueued (deduplicated) chat. */
  sent: SentChat[];
  /** Every sendChat call, duplicates included. */
  sendCalls: number;
  fileRequests: { ch: string; req: TransferRequest }[];
  emitted: DaemonEvent[];
  channels: Map<string, Channel>;
  messages: ChannelMessage[];
  cfg: SpencerConfig;
  cleanup(): void;
}

export function channel(id: string, kind: "direct" | "group", name: string, extra: Partial<Channel> = {}): Channel {
  const peers = kind === "direct" ? [BOB] : [BOB, CAROL];
  return {
    id,
    kind,
    name,
    relayUrl: "ws://127.0.0.1:1/ws",
    members: [{ ...ME, me: true }, ...peers.map((p) => ({ ...p, me: false }))],
    autoReply: true,
    allowedMcpTools: [],
    unread: 0,
    lastSeq: 0,
    createdAt: Date.now(),
    ...extra,
  };
}

export function makeCore(opts: { dir?: string; channels?: Channel[]; config?: Partial<SpencerConfig> } = {}): StubCore {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "spencer-agent-"));
  const db = new DatabaseSync(join(dir, "core.db"));
  const cfg: SpencerConfig = { ...defaultConfig(), name: ME.name, model: { provider: "fake" }, ...opts.config };
  cfg.policy = { ...defaultConfig().policy, ownerCodingTools: false, ...(opts.config?.policy ?? {}) };
  const channels = new Map<string, Channel>((opts.channels ?? [channel("chDirect", "direct", "Bob chat"), channel("chGroup", "group", "Team")]).map((c) => [c.id, c]));
  const byKey = new Map<string, string>();
  const core: StubCore = {
    dir,
    db,
    dataDir: dir,
    cfg,
    sent: [],
    sendCalls: 0,
    fileRequests: [],
    emitted: [],
    channels,
    messages: [],
    config: () => cfg,
    me: () => ME,
    listChannels: () => [...channels.values()],
    getChannel: (ch) => channels.get(ch),
    readChannel: (ch, limit) => core.messages.filter((m) => m.ch === ch).slice(-limit),
    sendChat(ch, msg) {
      core.sendCalls++;
      if (msg.idempotencyKey && byKey.has(msg.idempotencyKey)) return { id: byKey.get(msg.idempotencyKey)! };
      const id = randomUUID();
      if (msg.idempotencyKey) byKey.set(msg.idempotencyKey, id);
      core.sent.push({ ch, id, ...msg });
      core.messages.push({ id, ch, from: ME.id, mine: true, ts: Date.now(), type: "chat", text: msg.text, hop: msg.hop, by: msg.by, status: "pending" });
      return { id };
    },
    async requestFileSend(ch, req) {
      core.fileRequests.push({ ch, req });
      const now = Date.now();
      const t: Transfer = {
        tid: randomUUID(),
        ch,
        direction: "out",
        peer: req.to ?? BOB.id,
        name: req.path.split("/").pop() ?? "file",
        size: 1,
        sha256: "00",
        state: "awaiting_approval",
        attempt: 0,
        initiatedBy: req.initiatedBy,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 86_400_000,
      };
      return t;
    },
    listTransfers: () => [],
    async createInvite(kind, name) {
      const c = channel(`ch${channels.size + 1}`, kind, name);
      channels.set(c.id, c);
      return { link: `https://example.test/i/${c.id}#secret`, channel: c };
    },
    events: { emit: (e) => core.emitted.push(e) },
    cleanup() {
      try {
        db.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return core;
}

let seq = 0;
export function peerChat(
  ch: Channel,
  text: string,
  extra: Omit<Partial<IncomingChat>, "from"> & { hop?: number; mentions?: string[]; by?: "human" | "agent"; from?: typeof BOB } = {},
): IncomingChat {
  const from = extra.from ?? BOB;
  const { hop = 0, mentions, by = "human", from: _from, ...rest } = extra;
  return {
    id: `msg-${++seq}-${randomUUID()}`,
    ch: ch.id,
    seq,
    from: from.id,
    fromName: from.name,
    ts: Date.now(),
    body: { type: "chat", text, hop, by, ...(mentions ? { mentions } : {}) },
    channelKind: ch.kind,
    channelName: ch.name,
    ...rest,
  };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, what = "condition", timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
