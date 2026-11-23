import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { b64u, fromB64u, fromUtf8, random, randomId, utf8 } from "./encoding.ts";
import { joinProofMessage, signText } from "./identity.ts";

const SALT = utf8("spencer/v1");

export interface ChannelKeys {
  encKey: Uint8Array;
  capSecret: Uint8Array;
  capPub: string;
}

export function deriveChannelKeys(secret: string, ch: string): ChannelKeys {
  const s = fromB64u(secret, 32);
  const encKey = hkdf(sha256, s, SALT, utf8(`enc:${ch}`), 32);
  const capSecret = hkdf(sha256, s, SALT, utf8(`cap:${ch}`), 32);
  return { encKey, capSecret, capPub: b64u(ed25519.getPublicKey(capSecret)) };
}

export function joinProof(keys: ChannelKeys, ch: string, id: string, nonce: string): string {
  return signText(keys.capSecret, joinProofMessage(ch, id, nonce));
}

// ---------- invites ----------

export interface Invite {
  ch: string;
  secret: string;
  /** Origin the link points at, e.g. https://spencer.pjalv.com */
  origin: string;
  /** WebSocket URL of the relay derived from the origin. */
  relayUrl: string;
}

export function newChannelSecret(): { ch: string; secret: string } {
  return { ch: randomId(), secret: b64u(random(32)) };
}

/** relay ws url (wss://h/ws) → invite origin (https://h). */
export function originFromRelayUrl(relayUrl: string): string {
  const u = new URL(relayUrl);
  const proto = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : null;
  if (!proto) throw new Error("relay url must be ws:// or wss://");
  return `${proto}//${u.host}`;
}

export function relayUrlFromOrigin(origin: string): string {
  const u = new URL(origin);
  const proto = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : null;
  if (!proto) throw new Error("invite origin must be http(s)");
  return `${proto}//${u.host}/ws`;
}

export function formatInvite(relayUrl: string, ch: string, secret: string): string {
  return `${originFromRelayUrl(relayUrl)}/i/${ch}#${secret}`;
}

export function parseInvite(link: string): Invite {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    throw new Error("invite link is not a URL");
  }
  const m = /^\/i\/([A-Za-z0-9_-]{22})\/?$/.exec(u.pathname);
  if (!m) throw new Error("invite link has no channel id");
  const secret = u.hash.replace(/^#/, "");
  fromB64u(secret, 32); // validates
  const origin = `${u.protocol}//${u.host}`;
  return { ch: m[1], secret, origin, relayUrl: relayUrlFromOrigin(origin) };
}

// ---------- AEAD helpers ----------

export function sealWith(key: Uint8Array, aad: string, plaintext: Uint8Array): string {
  const n = random(24);
  const ct = xchacha20poly1305(key, n, utf8(aad)).encrypt(plaintext);
  const out = new Uint8Array(24 + ct.length);
  out.set(n, 0);
  out.set(ct, 24);
  return b64u(out);
}

export function openWith(key: Uint8Array, aad: string, sealed: string): Uint8Array {
  const raw = fromB64u(sealed);
  if (raw.length < 24 + 16) throw new Error("sealed blob too short");
  return xchacha20poly1305(key, raw.subarray(0, 24), utf8(aad)).decrypt(raw.subarray(24));
}

export interface ChannelMeta {
  name: string;
  kind: "direct" | "group";
  createdBy: string;
  /**
   * Groups only: "conversation" makes it a Conversations channel (agents start debates on their own timers). Absent:
   * an ordinary channel. Older Spencers ignore the field and see a plain group.
   */
  mode?: "conversation";
}

export function sealMeta(keys: ChannelKeys, ch: string, meta: ChannelMeta): string {
  return sealWith(keys.encKey, `spencer/v1/meta:${ch}`, utf8(JSON.stringify(meta)));
}

export function openMeta(keys: ChannelKeys, ch: string, sealed: string): ChannelMeta {
  const m = JSON.parse(fromUtf8(openWith(keys.encKey, `spencer/v1/meta:${ch}`, sealed)));
  if (typeof m?.name !== "string" || (m.kind !== "direct" && m.kind !== "group") || typeof m.createdBy !== "string") {
    throw new Error("bad channel meta");
  }
  return {
    name: m.name.slice(0, 200),
    kind: m.kind,
    createdBy: m.createdBy,
    ...(m.kind === "group" && m.mode === "conversation" ? { mode: "conversation" as const } : {}),
  };
}

// ---------- pairwise ----------

export function pairKey(mySecret: string, theirId: string, myId: string, ch: string): Uint8Array {
  const shared = x25519.getSharedSecret(
    ed25519.utils.toMontgomerySecret(fromB64u(mySecret, 32)),
    ed25519.utils.toMontgomery(fromB64u(theirId, 32)),
  );
  const [lo, hi] = myId < theirId ? [myId, theirId] : [theirId, myId];
  return hkdf(sha256, shared, SALT, utf8(`pair:${ch}:${lo}:${hi}`), 32);
}

export function sealFor(key: Uint8Array, tid: string, obj: unknown): string {
  return sealWith(key, `spencer/v1/seal:${tid}`, utf8(JSON.stringify(obj)));
}

export function openFrom<T = unknown>(key: Uint8Array, tid: string, sealed: string): T {
  return JSON.parse(fromUtf8(openWith(key, `spencer/v1/seal:${tid}`, sealed))) as T;
}

export function sealLink(key: Uint8Array, role: "offer" | "answer", sid: string, obj: unknown): string {
  return sealWith(key, `spencer/v1/link:${role}:${sid}`, utf8(JSON.stringify(obj)));
}
export function openLink<T = unknown>(key: Uint8Array, role: "offer" | "answer", sid: string, sealed: string): T {
  return JSON.parse(fromUtf8(openWith(key, `spencer/v1/link:${role}:${sid}`, sealed))) as T;
}
export function normalizeRelayUrl(input: string): string {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new Error("invalid relay URL"); }
  if (!["ws:", "wss:", "http:", "https:"].includes(u.protocol)) throw new Error("relay URL must use ws, wss, http or https");
  if (u.username || u.password || u.search || u.hash || input.trim().includes("?") || input.trim().includes("#")) throw new Error("relay URL cannot contain credentials, query or fragment");
  if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:";
  u.pathname = u.pathname === "/" ? "/ws" : u.pathname.replace(/\/+$/, "");
  return u.toString();
}
