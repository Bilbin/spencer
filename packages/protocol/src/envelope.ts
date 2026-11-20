import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { b64u, fromB64u, fromUtf8, isB64uId, random, randomId, utf8 } from "./encoding.ts";
import { signText, verifyText, type Identity } from "./identity.ts";
import { parseBody, type Body } from "./body.ts";

export const MAX_ENVELOPE_BYTES = 64 * 1024;

export interface Envelope {
  v: 1;
  id: string;
  ch: string;
  from: string;
  ts: number;
  n: string;
  ct: string;
  sig: string;
}

const header = (e: Pick<Envelope, "v" | "id" | "ch" | "from" | "ts">) =>
  `spencer/v1/env\n${e.v}\n${e.id}\n${e.ch}\n${e.from}\n${e.ts}`;

export const envelopeAad = header;
export const envelopeSigInput = (e: Omit<Envelope, "sig">) => `${header(e)}\n${e.n}\n${e.ct}`;

export function sealEnvelope(
  identity: Identity,
  ch: string,
  encKey: Uint8Array,
  body: Body,
  opts: { id?: string; ts?: number } = {},
): Envelope {
  const partial = { v: 1 as const, id: opts.id ?? randomId(), ch, from: identity.id, ts: opts.ts ?? Date.now() };
  const nonce = random(24);
  const ct = xchacha20poly1305(encKey, nonce, utf8(header(partial))).encrypt(utf8(JSON.stringify(body)));
  const unsigned = { ...partial, n: b64u(nonce), ct: b64u(ct) };
  const env: Envelope = { ...unsigned, sig: signText(identity.secret, envelopeSigInput(unsigned)) };
  if (envelopeSize(env) > MAX_ENVELOPE_BYTES) throw new Error("envelope too large");
  return env;
}

export function envelopeSize(env: Envelope): number {
  return Buffer.byteLength(JSON.stringify(env));
}

/** Structural check of an untrusted envelope (no crypto). */
export function isEnvelope(x: unknown): x is Envelope {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    e.v === 1 &&
    isB64uId(e.id) &&
    isB64uId(e.ch) &&
    isB64uId(e.from, 32) &&
    Number.isSafeInteger(e.ts) &&
    isB64uId(e.n, 24) &&
    typeof e.ct === "string" &&
    e.ct.length > 0 &&
    isB64uId(e.sig, 64)
  );
}

export function verifyEnvelope(env: Envelope): boolean {
  if (!isEnvelope(env)) return false;
  const { sig, ...unsigned } = env;
  return verifyText(env.from, envelopeSigInput(unsigned), sig);
}

/** Verifies signature, decrypts and validates the body. Throws on any failure. */
export function openEnvelope(env: Envelope, encKey: Uint8Array): Body {
  if (!verifyEnvelope(env)) throw new Error("bad envelope signature");
  const pt = xchacha20poly1305(encKey, fromB64u(env.n, 24), utf8(header(env))).decrypt(fromB64u(env.ct));
  const body = parseBody(JSON.parse(fromUtf8(pt)));
  if (!body) throw new Error("invalid or unknown body");
  return body;
}
