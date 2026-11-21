import { createRequire } from "node:module";
import { embedded } from "../sea.ts";

// On loopback, remoteFingerprint() is empty after SDP and reports SHA-256 only
// after DTLS connects. A tampered SDP fingerprint prevented the connection.
// This supports a live-certificate binding, subject to source verification.
type Addon = Pick<typeof import("node-datachannel"), "PeerConnection" | "DataChannel" | "cleanup" | "initLogger" | "setSctpSettings" | "preload" | "getLibraryVersion">;
type Result = { ok: true; addon: Addon; path: string } | { ok: false; error: string };
let cached: Result | undefined;

export function loadP2pAddon(override?: string): Result {
  if (override === undefined && cached) return cached;
  let result: Result;
  try {
    const require = createRequire(import.meta.url);
    const platform = process.platform === "linux" ? `${process.platform}-${process.arch}-gnu` : `${process.platform}-${process.arch}`;
    const path = override ?? process.env.SPENCER_P2P_ADDON_PATH ?? embedded()?.addons["node-datachannel"] ?? require.resolve(`@node-datachannel/${platform}`);
    const binding = { exports: {} };
    process.dlopen(binding, path);
    result = { ok: true, addon: binding.exports as Addon, path };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (override === undefined) cached = result;
  return result;
}

export function getP2pAddonStatus(): { available: boolean; error?: string } {
  const result = loadP2pAddon();
  return result.ok ? { available: true } : { available: false, error: result.error };
}
