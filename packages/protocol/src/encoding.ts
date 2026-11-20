import { randomBytes } from "@noble/hashes/utils.js";

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(b);

export function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

const B64U_RE = /^[A-Za-z0-9_-]*$/;
export function fromB64u(s: string, expectedLength?: number): Uint8Array {
  if (typeof s !== "string" || !B64U_RE.test(s)) throw new Error("invalid base64url");
  const out = new Uint8Array(Buffer.from(s, "base64url"));
  if (expectedLength !== undefined && out.length !== expectedLength) {
    throw new Error(`expected ${expectedLength} bytes, got ${out.length}`);
  }
  return out;
}

/** 16 random bytes, b64u. Used for message, channel and transfer ids. */
export function randomId(): string {
  return b64u(randomBytes(16));
}

export function random(n: number): Uint8Array {
  return randomBytes(n);
}

export function isB64uId(s: unknown, bytes = 16): s is string {
  if (typeof s !== "string" || !B64U_RE.test(s)) return false;
  return s.length === Math.ceil((bytes * 4) / 3);
}
