import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { b64u, fromB64u, utf8 } from "./encoding.ts";

export interface Identity {
  /** b64u Ed25519 public key (the identity id). */
  id: string;
  /** b64u 32-byte Ed25519 secret key. */
  secret: string;
}

export function generateIdentity(): Identity {
  const secret = ed25519.utils.randomSecretKey();
  return { id: b64u(ed25519.getPublicKey(secret)), secret: b64u(secret) };
}

export function identityFromSecret(secret: string): Identity {
  const sk = fromB64u(secret, 32);
  return { id: b64u(ed25519.getPublicKey(sk)), secret };
}

export function fingerprint(id: string): string {
  const hex = bytesToHex(sha256(fromB64u(id, 32)).slice(0, 10));
  return hex.match(/.{4}/g)!.join("-");
}

export function signBytes(secret: string | Uint8Array, msg: Uint8Array): string {
  const sk = typeof secret === "string" ? fromB64u(secret, 32) : secret;
  return b64u(ed25519.sign(msg, sk));
}

export function verifyBytes(pub: string, msg: Uint8Array, sig: string): boolean {
  try {
    return ed25519.verify(fromB64u(sig, 64), msg, fromB64u(pub, 32));
  } catch {
    return false;
  }
}

export function signText(secret: string | Uint8Array, text: string): string {
  return signBytes(secret, utf8(text));
}

export function verifyText(pub: string, text: string, sig: string): boolean {
  return verifyBytes(pub, utf8(text), sig);
}

/** Relay auth: signature over "spencer/v1/relay-auth:" + nonce. */
export const relayAuthMessage = (nonce: string): string => `spencer/v1/relay-auth:${nonce}`;

/** Join/create proof: signed with the channel capability key. */
export const joinProofMessage = (ch: string, id: string, nonce: string): string =>
  `spencer/v1/join:${ch}:${id}:${nonce}`;
