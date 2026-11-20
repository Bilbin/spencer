import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION, tx } from "../../src/store/db.ts";
import { acquireLock, DataDirLockedError } from "../../src/store/lock.ts";
import { loadOrCreateIdentity, loadOrCreateToken } from "../../src/store/files.ts";
import { Daemon } from "../../src/daemon.ts";
import { StubAgent, StubTransfers, tempDir, quietLog } from "./helpers.ts";

test("store: migrations are idempotent and files are private", () => {
  const t = tempDir();
  try {
    const db1 = openDb(t.dir);
    db1.prepare("INSERT INTO channels (id, kind, meta_name, created_by, relay_url, secret, created_at) VALUES ('c','direct','x','me','ws://x/ws','s',1)").run();
    db1.close();
    const db2 = openDb(t.dir);
    assert.equal((db2.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    assert.equal((db2.prepare("SELECT count(*) AS n FROM channels").get() as { n: number }).n, 1);
    db2.close();
    if (process.platform !== "win32") {
      assert.equal(statSync(join(t.dir, "spencer.sqlite")).mode & 0o777, 0o600);
      assert.equal(statSync(t.dir).mode & 0o077, 0);
    }
  } finally {
    t.cleanup();
  }
});

test("store: tx nests via savepoints and rolls back the inner part only", () => {
  const t = tempDir();
  try {
    const db = openDb(t.dir);
    db.exec("CREATE TABLE x (v INTEGER)");
    tx(db, () => {
      db.exec("INSERT INTO x VALUES (1)");
      assert.throws(() =>
        tx(db, () => {
          db.exec("INSERT INTO x VALUES (2)");
          throw new Error("boom");
        }),
      );
    });
    assert.deepEqual(
      (db.prepare("SELECT v FROM x").all() as { v: number }[]).map((r) => r.v),
      [1],
    );
    db.close();
  } finally {
    t.cleanup();
  }
});

test("store: identity and api token are stable and 0600", () => {
  const t = tempDir();
  try {
    const a = loadOrCreateIdentity(t.dir);
    const b = loadOrCreateIdentity(t.dir);
    assert.deepEqual(a, b);
    const tok = loadOrCreateToken(t.dir);
    assert.match(tok, /^[0-9a-f]{64}$/);
    assert.equal(loadOrCreateToken(t.dir), tok);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(t.dir, "identity.json")).mode & 0o777, 0o600);
      assert.equal(statSync(join(t.dir, "api-token")).mode & 0o777, 0o600);
    }
  } finally {
    t.cleanup();
  }
});

test("store: lock refuses a second holder and takes over a stale lock", () => {
  const t = tempDir();
  try {
    const lock = acquireLock(t.dir);
    assert.equal(readFileSync(lock.path, "utf8"), String(process.pid));
    assert.throws(() => acquireLock(t.dir), DataDirLockedError);
    lock.release();
    assert.ok(!existsSync(lock.path));

    // A pid that certainly exited.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    assert.ok(dead);
    writeFileSync(join(t.dir, "spencer.lock"), String(dead));
    const l2 = acquireLock(t.dir);
    assert.equal(readFileSync(l2.path, "utf8"), String(process.pid));
    l2.release();
  } finally {
    t.cleanup();
  }
});

test("daemon: a second Daemon on the same data dir is refused", async () => {
  const t = tempDir();
  const mk = () =>
    new Daemon({
      dataDir: t.dir,
      config: { relay: "ws://127.0.0.1:1/ws", http: { host: "127.0.0.1", port: 0 }, model: { provider: "fake" } },
      agentFactory: (c) => new StubAgent(c),
      transferFactory: (d) => new StubTransfers(d),
      log: quietLog,
      webRoot: null,
    });
  const a = mk();
  await a.start();
  try {
    const b = mk();
    await assert.rejects(b.start(), /another Spencer is using this data dir/);
  } finally {
    await a.stop();
    t.cleanup();
  }
  assert.ok(!existsSync(join(t.dir, "spencer.lock")));
});
