import type { Envelope } from "./envelope.ts";

export type ChannelKind = "direct" | "group";
export interface CrocInfo {
  relay: string;
  pass: string;
}
export interface MemberInfo {
  id: string;
  joinedAt: number;
}

// ----- client → relay -----
export type ClientFrame =
  | { t: "auth"; id: string; sig: string }
  | { t: "create"; rid: string; ch: string; kind: ChannelKind; maxMembers: number; capPub: string; meta: string; proof: string }
  | { t: "join"; rid: string; ch: string; proof: string }
  | { t: "leave"; rid: string; ch: string }
  | { t: "members"; rid: string; ch: string }
  | { t: "send"; rid: string; env: Envelope }
  | { t: "sub"; rid: string; ch: string; since: number }
  | { t: "ack"; ch: string; seq: number }
  | { t: "ping"; rid: string };

// ----- relay → client -----
export type ServerFrame =
  | { t: "challenge"; nonce: string; server: string }
  | { t: "welcome"; id: string; croc?: CrocInfo }
  | { t: "ok"; rid: string; [k: string]: unknown }
  | { t: "err"; rid?: string; code: RelayErrorCode; msg: string }
  | { t: "msg"; ch: string; seq: number; env: Envelope }
  | { t: "member"; ch: string; id: string; event: "joined" | "left" };

export type RelayErrorCode =
  | "unauthenticated"
  | "bad_request"
  | "not_member"
  | "no_channel"
  | "full"
  | "bad_proof"
  | "bad_sig"
  | "too_large"
  | "rate_limited"
  | "limit";

export interface CreateOk {
  head: number;
  members: MemberInfo[];
  croc?: CrocInfo;
}
export interface JoinOk {
  kind: ChannelKind;
  maxMembers: number;
  meta: string;
  head: number;
  members: MemberInfo[];
  croc?: CrocInfo;
}
export interface SubOk {
  head: number;
  first: number;
  members: MemberInfo[];
}

export const RELAY_SERVER_NAME = "spencer-relay/1";
export const MAX_FRAME_BYTES = 128 * 1024;
export const DIRECT_MAX_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 32;
