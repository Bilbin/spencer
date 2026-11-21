import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, resolveConfig } from "../../src/config.ts";

test("P2P defaults, validation and relay normalization", () => {
  const defaults = defaultConfig();
  assert.equal(defaults.p2p.minFileBytes, 4 * 1024 * 1024);
  assert.equal(resolveConfig({ relay: "https://hub.example" }).relay, "wss://hub.example/ws");
  assert.throws(() => resolveConfig({ p2p: { ...defaults.p2p, stun: ["host:65536"] } }));
  assert.throws(() => resolveConfig({ p2p: { ...defaults.p2p, minFileBytes: -1 } }));
  assert.deepEqual(resolveConfig({ p2p: { ...defaults.p2p, stun: ["[::1]:3478"] } }).p2p.stun, ["[::1]:3478"]);
  const old = process.env.SPENCER_RELAY;
  try {
    process.env.SPENCER_RELAY = "https://other.example";
    assert.equal(resolveConfig({ relay: "wss://hub.example/ws" }).relay, "wss://other.example/ws");
  } finally {
    if (old === undefined) delete process.env.SPENCER_RELAY; else process.env.SPENCER_RELAY = old;
  }
});
