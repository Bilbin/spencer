import { isB64uId } from "./encoding.ts";

export const MAX_CHAT_TEXT = 16_000;
export const AGENT_VERSION = "spencer/0.1";

export type HelloBody = { type: "hello"; name: string; about?: string; agent: string };
export type ChatBody = {
  type: "chat";
  text: string;
  hop: number;
  by: "human" | "agent";
  replyTo?: string;
  mentions?: string[];
};
export type FileOfferBody = {
  type: "file_offer";
  tid: string;
  to: string;
  name: string;
  size: number;
  sha256: string;
  expiresAt: number;
};
export type FileAcceptBody = { type: "file_accept"; tid: string; to: string; sealed: string };
export type FileDeclineBody = { type: "file_decline"; tid: string; to: string; reason?: string };
export type FileReadyBody = { type: "file_ready"; tid: string; to: string; attempt: number };
export type FileRetryBody = { type: "file_retry"; tid: string; to: string; attempt: number };
export type FileAckBody = { type: "file_ack"; tid: string; to: string; ok: boolean; sha256?: string; reason?: string };
export type FileCancelBody = { type: "file_cancel"; tid: string; to: string; reason: string };

export type FileBody =
  | FileOfferBody
  | FileAcceptBody
  | FileDeclineBody
  | FileReadyBody
  | FileRetryBody
  | FileAckBody
  | FileCancelBody;

export type Body = HelloBody | ChatBody | FileBody;

export const FILE_BODY_TYPES = new Set([
  "file_offer",
  "file_accept",
  "file_decline",
  "file_ready",
  "file_retry",
  "file_ack",
  "file_cancel",
]);

export function isFileBody(b: Body): b is FileBody {
  return FILE_BODY_TYPES.has(b.type);
}

const isStr = (v: unknown, max = 1000): v is string => typeof v === "string" && v.length <= max;
const isInt = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const isId32 = (v: unknown): v is string => isB64uId(v, 32);
const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** Validates an untrusted decrypted body. Returns null for unknown or malformed bodies. */
export function parseBody(raw: unknown): Body | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  switch (b.type) {
    case "hello":
      if (!isStr(b.name, 200) || !isStr(b.agent, 100)) return null;
      if (b.about !== undefined && !isStr(b.about, 2000)) return null;
      return { type: "hello", name: b.name, agent: b.agent, ...(b.about !== undefined ? { about: b.about as string } : {}) };
    case "chat": {
      if (!isStr(b.text, MAX_CHAT_TEXT) || !isInt(b.hop) || (b.by !== "human" && b.by !== "agent")) return null;
      if (b.replyTo !== undefined && !isB64uId(b.replyTo)) return null;
      if (b.mentions !== undefined && (!Array.isArray(b.mentions) || b.mentions.length > 64 || !b.mentions.every(isId32)))
        return null;
      const out: ChatBody = { type: "chat", text: b.text, hop: b.hop, by: b.by };
      if (b.replyTo !== undefined) out.replyTo = b.replyTo as string;
      if (b.mentions !== undefined) out.mentions = b.mentions as string[];
      return out;
    }
  }
  if (!FILE_BODY_TYPES.has(b.type as string)) return null;
  if (!isB64uId(b.tid) || !isId32(b.to)) return null;
  const base = { tid: b.tid as string, to: b.to as string };
  switch (b.type) {
    case "file_offer":
      if (!isStr(b.name, 255) || b.name.length === 0 || !isInt(b.size) || !isSha(b.sha256) || !isInt(b.expiresAt)) return null;
      return { type: "file_offer", ...base, name: b.name, size: b.size, sha256: b.sha256, expiresAt: b.expiresAt };
    case "file_accept":
      if (!isStr(b.sealed, 1000)) return null;
      return { type: "file_accept", ...base, sealed: b.sealed };
    case "file_decline":
      if (b.reason !== undefined && !isStr(b.reason)) return null;
      return { type: "file_decline", ...base, ...(b.reason !== undefined ? { reason: b.reason as string } : {}) };
    case "file_ready":
    case "file_retry":
      if (!isInt(b.attempt, 1)) return null;
      return { type: b.type, ...base, attempt: b.attempt };
    case "file_ack":
      if (typeof b.ok !== "boolean") return null;
      if (b.sha256 !== undefined && !isSha(b.sha256)) return null;
      if (b.reason !== undefined && !isStr(b.reason)) return null;
      return {
        type: "file_ack",
        ...base,
        ok: b.ok,
        ...(b.sha256 !== undefined ? { sha256: b.sha256 as string } : {}),
        ...(b.reason !== undefined ? { reason: b.reason as string } : {}),
      };
    case "file_cancel":
      if (!isStr(b.reason)) return null;
      return { type: "file_cancel", ...base, reason: b.reason };
  }
  return null;
}

/** Sanitizes a peer-supplied file name for local storage. */
export function sanitizeFileName(name: string): string {
  let n = name.normalize("NFC").replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_").trim();
  n = n.replace(/^\.+/, "_");
  if (n.length === 0) n = "file";
  if (n.length > 200) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : "";
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n;
}
