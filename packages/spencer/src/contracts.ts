/**
 * Internal contracts between the parts of the Spencer daemon.
 *
 *   core  = store, relay client, outbox, inbox, channels, HTTP API, daemon wiring
 *   xfer  = transfers state machine + croc runner
 *   agent = pi-durable runtime adapter, models, MCP, tools, reply policy
 *
 * Each part depends only on these interfaces, never on another part's internals.
 * API-facing shapes (Channel, ChannelMessage, Transfer, OwnerItem, McpServer) are the
 * JSON the local HTTP API returns; see docs/PROTOCOL.md §8.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ChatBody, CrocInfo, FileBody, Identity } from "@spencer/protocol";
import type { SpencerConfig, Policy } from "./config.ts";

// ---------------------------------------------------------------- API shapes

export interface ChannelMember {
  id: string;
  name?: string;
  fingerprint: string;
  me: boolean;
}

export interface Channel {
  id: string;
  kind: "direct" | "group";
  name: string;
  relayUrl: string;
  members: ChannelMember[];
  autoReply: boolean;
  allowedMcpTools: string[];
  unread: number;
  lastSeq: number;
  createdAt: number;
}

export type MessageOrigin = "human" | "owner-agent" | "agent-reply" | "peer";

export interface ChannelMessage {
  id: string;
  ch: string;
  from: string;
  fromName?: string;
  mine: boolean;
  ts: number;
  seq?: number;
  type: string;
  text?: string;
  hop?: number;
  by?: "human" | "agent";
  replyTo?: string;
  mentions?: string[];
  /** "failed": the relay permanently rejected our message (see `note`); it will not be retried. */
  status: "pending" | "sent" | "received" | "failed";
  /** Why an incoming chat did not trigger a reply ("not addressed", "hop cap", "rate limited", "auto-reply off"). */
  note?: string;
  origin?: MessageOrigin;
}

export type TransferDirection = "out" | "in";
export type TransferInitiator = "owner" | "owner-agent" | "peer-agent" | "peer";
export type OutgoingState =
  | "awaiting_approval"
  | "offered"
  | "sending"
  | "completed"
  | "denied"
  | "declined"
  | "failed"
  | "expired"
  | "cancelled";
export type IncomingState =
  | "offered"
  | "accepted"
  | "receiving"
  | "completed"
  | "declined"
  | "failed"
  | "expired"
  | "cancelled";
export const TERMINAL_STATES = new Set(["completed", "denied", "declined", "failed", "expired", "cancelled"]);

export interface Transfer {
  tid: string;
  ch: string;
  direction: TransferDirection;
  peer: string;
  peerName?: string;
  name: string;
  size: number;
  sha256: string;
  state: OutgoingState | IncomingState;
  attempt: number;
  initiatedBy: TransferInitiator;
  /** Free-text reason given by whoever initiated it (e.g. the peer agent's justification). */
  reason?: string;
  /** Fraction 0–1 while sending/receiving (1 once completed); absent before croc reports anything. */
  progress?: number;
  error?: string;
  /** Local path: staged copy (out) or quarantined file (in, once completed). */
  path?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface OwnerItem {
  id: string;
  role: "user" | "assistant" | "tool" | "note";
  text: string;
  ts: number;
  toolName?: string;
  isError?: boolean;
  /** The text comes from another person's agent (e.g. a peer's reply to something the owner sent): show it as untrusted. */
  untrusted?: boolean;
}

export interface McpServerStatus {
  name: string;
  transport: "stdio" | "http";
  status: "connected" | "error" | "disabled" | "connecting";
  error?: string;
  tools: { name: string; description?: string }[];
}

// ---------------------------------------------------------------- events

export type DaemonEvent =
  | { type: "channel"; channel: Channel }
  | { type: "channel_removed"; ch: string }
  | { type: "message"; ch: string; message: ChannelMessage }
  | { type: "transfer"; transfer: Transfer }
  | { type: "owner"; item: OwnerItem }
  | { type: "owner_busy"; busy: boolean }
  | { type: "relay"; url: string; connected: boolean }
  | { type: "mcp"; servers: McpServerStatus[] };

export interface EventSink {
  emit(e: DaemonEvent): void;
}

// ---------------------------------------------------------------- core → xfer

/** What the transfer manager needs from the core. */
export interface TransferDeps {
  db: DatabaseSync;
  dataDir: string;
  me: Identity;
  policy: () => Policy;
  /**
   * Durably enqueue a file_* body to the channel's outbox. Synchronous: it only inserts a row,
   * so it can be called inside a db transaction (BEGIN/COMMIT) together with a state change.
   */
  enqueue(ch: string, body: FileBody): void;
  /** Croc relay for this channel's relay (relay welcome/join info, overridden by config). */
  crocInfo(ch: string): CrocInfo | undefined;
  /** Symmetric pairwise key with a channel member (protocol pairKey). */
  pairKey(ch: string, peerId: string): Uint8Array;
  /** Channel members except me. */
  peers(ch: string): string[];
  peerName(ch: string, peerId: string): string | undefined;
  crocPath: string;
  events: EventSink;
  /** Short informational note for the owner conversation (never starts a model run). */
  ownerNote(text: string): void;
  now?: () => number;
}

export interface TransferRequest {
  path: string;
  /** Recipient identity; optional for direct channels. */
  to?: string;
  initiatedBy: "owner" | "owner-agent" | "peer-agent";
  reason?: string;
}

export interface TransferService {
  start(): Promise<void>;
  stop(): Promise<void>;
  request(ch: string, req: TransferRequest): Promise<Transfer>;
  approve(tid: string): Transfer;
  deny(tid: string): Transfer;
  accept(tid: string): Transfer;
  decline(tid: string): Transfer;
  cancel(tid: string): Transfer;
  /** Incoming file_* body from `from` in `ch`. Must be idempotent. */
  onBody(ch: string, from: string, body: FileBody): Promise<void>;
  list(ch?: string): Transfer[];
  get(tid: string): Transfer | undefined;
}

// ---------------------------------------------------------------- core → agent

export interface IncomingChat {
  id: string;
  ch: string;
  seq: number;
  from: string;
  fromName?: string;
  ts: number;
  body: ChatBody;
  channelKind: "direct" | "group";
  channelName: string;
  /** Origin of the local message this one replies to, if it replies to one of ours. */
  replyToOrigin?: MessageOrigin;
  /** Text of the message being replied to, if known. */
  replyToText?: string;
}

export interface OutgoingChat {
  id: string;
  ch: string;
  text: string;
  origin: MessageOrigin;
  ts: number;
}

/** What the agent layer needs from the core. */
export interface CoreServices {
  db: DatabaseSync;
  dataDir: string;
  config: () => SpencerConfig;
  me(): { id: string; name: string; fingerprint: string };
  listChannels(): Channel[];
  getChannel(ch: string): Channel | undefined;
  readChannel(ch: string, limit: number): ChannelMessage[];
  /**
   * Durably enqueue a chat message. `idempotencyKey`: a second call with the same key returns the
   * first message's id and enqueues nothing (used for exactly-once replies).
   */
  sendChat(
    ch: string,
    msg: {
      text: string;
      hop: number;
      by: "human" | "agent";
      origin: MessageOrigin;
      replyTo?: string;
      mentions?: string[];
      idempotencyKey?: string;
    },
  ): { id: string };
  requestFileSend(ch: string, req: TransferRequest): Promise<Transfer>;
  listTransfers(ch?: string): Transfer[];
  createInvite(kind: "direct" | "group", name: string): Promise<{ link: string; channel: Channel }>;
  events: EventSink;
}

/** What the core calls on the agent layer. */
export interface AgentService {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * An incoming chat from a peer. May be called more than once for the same id (crash recovery);
   * must be idempotent. Resolves once the message is durably handed to the agent runtime (not when
   * the reply is done). Returns the routing note shown in the UI (undefined = will reply).
   */
  onPeerChat(msg: IncomingChat): Promise<{ note?: string }>;
  /** We sent a chat in a channel (owner typed it, or the owner agent sent it): record as channel context. */
  onOutgoingChat(msg: OutgoingChat): Promise<void>;
  ownerSend(text: string): Promise<{ submissionId: string }>;
  ownerTranscript(limit: number): Promise<OwnerItem[]>;
  ownerBusy(): boolean;
  /** Informational note appended to the owner conversation (never starts a run). */
  ownerNote(text: string): Promise<void>;
  /** A channel was created/joined/updated (settings, members): reconfigure its conversation. */
  channelChanged(ch: string): Promise<void>;
  mcpStatus(): McpServerStatus[];
}
