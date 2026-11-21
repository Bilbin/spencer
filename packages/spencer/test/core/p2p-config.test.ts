import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, resolveConfig } from "../../src/config.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/store/db.ts";

test("migrates a v2 database without losing channel or member data", () => {
  const dir = mkdtempSync(join(tmpdir(), "p2p-migration-"));
  try {
    const old = new DatabaseSync(join(dir, "spencer.sqlite"));
    old.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY, kind TEXT NOT NULL, meta_name TEXT NOT NULL, custom_name TEXT, created_by TEXT NOT NULL, relay_url TEXT NOT NULL, secret TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, auto_reply INTEGER NOT NULL DEFAULT 1, allowed_mcp_tools TEXT NOT NULL DEFAULT '[]', last_hello_members TEXT NOT NULL DEFAULT '[]', unread INTEGER NOT NULL DEFAULT 0, gap INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, trust TEXT NOT NULL DEFAULT 'standard');
      CREATE TABLE members (ch TEXT NOT NULL, id TEXT NOT NULL, name TEXT, about TEXT, agent TEXT, present INTEGER NOT NULL DEFAULT 1, joined_at INTEGER, PRIMARY KEY(ch,id));
      INSERT INTO channels (id,kind,meta_name,created_by,relay_url,secret,created_at) VALUES ('ch','direct','name','me','ws://hub','secret',42);
      INSERT INTO members (ch,id,name) VALUES ('ch','peer','Alice');
      PRAGMA user_version = 2;`);
    old.close();
    const db = openDb(dir);
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 3);
      const channel = db.prepare("SELECT * FROM channels WHERE id = 'ch'").get()!;
      assert.equal(channel.meta_name, "name");
      assert.equal(channel.last_hello_features, "[]");
      assert.equal(channel.direct_link, "auto");
      assert.equal(channel.allow_local_addresses, 0);
      const member = db.prepare("SELECT * FROM members WHERE id = 'peer'").get()!;
      assert.equal(member.name, "Alice");
      assert.equal(member.features, "[]");
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
