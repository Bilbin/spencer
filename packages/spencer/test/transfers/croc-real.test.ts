/** End-to-end transfers through the real pinned croc binary and a local croc relay. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isOwnedCroc, reapCrocOrphans, realCrocRunner } from "../../src/transfers/index.ts";
import { pair, waitFor } from "./harness.ts";
import type { TNode } from "./harness.ts";

const CROC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.bin/croc");
const haveCroc = existsSync(CROC);
if (!haveCroc) console.log(`# skipping real croc tests: ${CROC} not found (run scripts to fetch croc v10.3.1)`);

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen({ port, host: "0.0.0.0", exclusive: true }, () => s.close(() => res(true)));
  });
}

async function freePorts(n: number): Promise<number[]> {
  for (let tries = 0; tries < 50; tries++) {
    const base = 20000 + Math.floor(Math.random() * 40000);
    const ports = Array.from({ length: n }, (_, i) => base + i);
    let ok = true;
    for (const p of ports) if (!(await portFree(p))) ok = false;
    if (ok) return ports;
  }
  throw new Error("no free port range");
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      res(true);
    });
    s.once("error", () => res(false));
  });
}

/** croc processes that are children of this test process (excluding the relay). */
function crocChildren(exclude: number | undefined): number[] {
  try {
    const out = execFileSync("ps", ["-o", "pid=,comm=", "--ppid", String(process.pid)], { encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter(([pid, comm]) => pid && comm === "croc" && Number(pid) !== exclude)
      .map(([pid]) => Number(pid));
  } catch {
    return [];
  }
}

function makeFile(node: TNode, name: string, bytes: number): { path: string; data: Buffer } {
  const src = join(node.dir, "src");
  mkdirSync(src, { recursive: true });
  const data = randomBytes(bytes);
  const path = join(src, name);
  writeFileSync(path, data);
  return { path, data };
}

describe("transfers (real croc)", { skip: haveCroc ? false : "croc binary missing", timeout: 60_000 }, () => {
  let relay: ChildProcess | undefined;
  let relayAddr = "";
  const pass = randomBytes(12).toString("hex");

  before(async () => {
    const ports = await freePorts(5);
    relay = spawn(CROC, ["--pass", pass, "relay", "--ports", ports.join(",")], { stdio: "ignore" });
    relayAddr = `127.0.0.1:${ports[0]}`;
    await waitFor(() => relay!.exitCode === null, "relay alive");
    const end = Date.now() + 10_000;
    while (!(await canConnect(ports[0]))) {
      if (relay.exitCode !== null || Date.now() > end) throw new Error("croc relay did not start");
      await new Promise((r) => setTimeout(r, 50));
    }
    // the relay opens its data ports right after the first; give it a beat
    await new Promise((r) => setTimeout(r, 200));
  });

  after(async () => {
    if (relay && relay.exitCode === null) {
      const gone = new Promise((r) => relay!.once("exit", r));
      relay.kill("SIGTERM");
      await gone;
    }
  });

  it("sends files both ways through the croc relay, concurrently", async (t) => {
    const runner = realCrocRunner(CROC, { readyGraceMs: 300 });
    const p = await pair({
      runner,
      a: { policy: { requireApprovalForOutgoingFiles: false } },
      b: { policy: { requireApprovalForOutgoingFiles: false } },
    });
    try {
      p.A.info = { relay: relayAddr, pass };
      p.B.info = { relay: relayAddr, pass };
      const fa = makeFile(p.A, "from-alice.bin", 3 * 1024 * 1024);
      const fb = makeFile(p.B, "from-bob.dat", 1024 * 1024 + 7);
      const [ta, tb] = await Promise.all([
        p.A.s.request(p.ch, { path: fa.path, initiatedBy: "owner" }),
        p.B.s.request(p.ch, { path: fb.path, initiatedBy: "owner" }),
      ]);
      await waitFor(
        () =>
          p.A.state(ta.tid) === "completed" &&
          p.B.state(ta.tid) === "completed" &&
          p.B.state(tb.tid) === "completed" &&
          p.A.state(tb.tid) === "completed",
        "both transfers",
        30_000,
      ).catch((e) => {
        throw new Error(`${e.message}: ${JSON.stringify([p.A.s.list(), p.B.s.list()], null, 1)}`);
      });
      const atB = p.B.s.get(ta.tid)!;
      const atA = p.A.s.get(tb.tid)!;
      assert.equal(atB.path, join(p.B.dataDir, "quarantine", ta.tid, "from-alice.bin"));
      assert.equal(atA.path, join(p.A.dataDir, "quarantine", tb.tid, "from-bob.dat"));
      assert.equal(sha(readFileSync(atB.path!)), sha(fa.data));
      assert.equal(sha(readFileSync(atA.path!)), sha(fb.data));
      assert.equal(statSync(atB.path!).mode & 0o777, 0o600);
      // progress is a fraction 0–1 everywhere (PROTOCOL §8)
      const ps = [...p.A.events, ...p.B.events].map((e) => e.progress).filter((x) => x !== undefined);
      assert.ok(ps.length > 0 && ps.every((x) => x >= 0 && x <= 1), `progress values: ${ps.join(",")}`);
      t.diagnostic(`attempts used: A→B ${p.A.s.get(ta.tid)!.attempt}, B→A ${p.B.s.get(tb.tid)!.attempt}`);
      // the croc code / relay password never show up in what the daemon exposes
      const dump = JSON.stringify([p.A.events, p.B.events, p.A.notes, p.B.notes]);
      assert.ok(!dump.includes(pass));
      assert.ok(!/\d{4}-[0-9a-f]{32}/.test(dump));
    } finally {
      await p.close();
    }
    assert.deepEqual(crocChildren(relay?.pid), [], "no croc processes left");
  });

  it("a wrong relay password fails cleanly", async () => {
    const runner = realCrocRunner(CROC, { readyGraceMs: 300 });
    const p = await pair({
      runner,
      a: {
        policy: { requireApprovalForOutgoingFiles: false, maxTransferAttempts: 2 },
        service: { backoffMs: () => 200 },
      },
    });
    try {
      p.A.info = { relay: relayAddr, pass };
      p.B.info = { relay: relayAddr, pass: "definitely-wrong" };
      const f = makeFile(p.A, "x.bin", 100_000);
      const t = await p.A.s.request(p.ch, { path: f.path, initiatedBy: "owner" });
      await waitFor(() => p.A.state(t.tid) === "failed" && p.B.state(t.tid) === "cancelled", "clean failure", 30_000);
      const err = p.B.events.map((e) => e.error ?? "").join("\n");
      assert.match(err, /bad password/);
      assert.ok(!err.includes("definitely-wrong") && !err.includes(pass), "password is redacted from errors");
      assert.equal(existsSync(join(p.B.dataDir, "quarantine", t.tid)), false);
      assert.equal(existsSync(join(p.A.dataDir, "outgoing", t.tid)), false);
    } finally {
      await p.close();
    }
    assert.deepEqual(crocChildren(relay?.pid), [], "no croc processes left");
  });

  it("reapCrocOrphans kills only croc processes recorded in the pid file that belong to the data dir", { skip: existsSync("/proc/self/cmdline") ? false : "needs /proc" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "spencer-reap-"));
    const procs: ChildProcess[] = [];
    const exited = (p: ChildProcess) => new Promise((r) => (p.exitCode !== null || p.signalCode !== null ? r(null) : p.once("exit", r)));
    try {
      const owned = join(dir, "data");
      mkdirSync(join(owned, "outgoing"), { recursive: true });
      const ports = await freePorts(2);
      // An orphan stand-in: a croc that runs until killed, with its cwd in the data dir (like `croc send`).
      const mine = spawn(CROC, ["--pass", "x", "relay", "--ports", ports.join(",")], { cwd: join(owned, "outgoing"), stdio: "ignore" });
      // Not croc, but inside the data dir.
      const notCroc = spawn("sleep", ["30"], { cwd: owned, stdio: "ignore" });
      procs.push(mine, notCroc);
      await waitFor(() => mine.pid !== undefined && notCroc.pid !== undefined, "spawned");
      await waitFor(() => isOwnedCroc(mine.pid!, owned), "croc visible in /proc");
      assert.equal(isOwnedCroc(notCroc.pid!, owned), false, "not croc");
      assert.equal(isOwnedCroc(relay!.pid!, owned), false, "croc outside the data dir");
      assert.equal(isOwnedCroc(process.pid, owned), false);
      const pidFile = join(owned, "croc.pids");
      writeFileSync(pidFile, [mine.pid, notCroc.pid, relay!.pid, process.pid, 999_999_999, "junk"].join("\n"));
      assert.deepEqual(reapCrocOrphans({ path: pidFile, ownedDir: owned }), [mine.pid]);
      await exited(mine);
      assert.equal(mine.signalCode, "SIGKILL");
      assert.equal(notCroc.exitCode === null && notCroc.signalCode === null, true, "sleep untouched");
      assert.equal(relay!.exitCode, null, "the test's croc relay untouched");
      assert.equal(existsSync(pidFile), false, "pid file removed");
      assert.deepEqual(reapCrocOrphans({ path: pidFile, ownedDir: owned }), [], "no file: nothing to do");
    } finally {
      for (const p of procs) {
        p.kill("SIGKILL");
        await exited(p);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the runner records live croc pids in the pid file and removes them on exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spencer-pids-"));
    try {
      const pidFile = join(dir, "croc.pids");
      const runner = realCrocRunner(CROC, { pidFile: { path: pidFile, ownedDir: dir } });
      const out = join(dir, "incoming");
      mkdirSync(out);
      // Nobody sends: the receiver keeps retrying the room until killed.
      const job = runner.receive({ outDir: out, code: "1234-" + "ab".repeat(16), relay: relayAddr, pass });
      await waitFor(() => existsSync(pidFile), "pid file written");
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      assert.ok(Number.isInteger(pid) && pid > 1);
      job.kill();
      await job.done;
      assert.equal(existsSync(pidFile), false, "pid file removed when nothing runs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
