/**
 * croc process integration. The croc code and the relay password are passed only through the
 * environment (CROC_SECRET) and argv respectively; croc's output is never logged because the sender
 * prints both the code and the relay password in its "on the other computer run" instructions.
 *
 * Note on argv: `--pass` is visible in `ps` for the lifetime of the process. croc v10.3.1 has no
 * env var or file option for the relay password that we could use instead, so this is unavoidable;
 * the relay password is a shared access-control secret, not an end-to-end key (croc's PAKE uses the code).
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, copyFileSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { basename, join } from "node:path";

export interface CrocExit {
  /** Process exit code (null when killed or failed to spawn). */
  code: number | null;
  /** True when the job was stopped through kill(). */
  killed: boolean;
  /** Last meaningful line of croc's output, with the code and password redacted. */
  error?: string;
}

export interface CrocJob {
  readonly done: Promise<CrocExit>;
  kill(): void;
}

interface CrocCommon {
  code: string;
  relay: string;
  pass: string;
  /** Progress as a fraction 0–1 (parsed from croc's percentage bar). */
  onProgress?(fraction: number): void;
}

export interface CrocSendOptions extends CrocCommon {
  file: string;
  /** Called once when the sender is (very likely) waiting in the relay room. */
  onReady(): void;
}

export interface CrocReceiveOptions extends CrocCommon {
  outDir: string;
}

export interface CrocRunner {
  send(opts: CrocSendOptions): CrocJob;
  receive(opts: CrocReceiveOptions): CrocJob;
}

export const CROC_CODE_RE = /^\d{4}-[0-9a-f]{32}$/;

export interface RealCrocOptions {
  /** Delay after the sender printed its instructions before signalling ready (it joins the room after printing). */
  readyGraceMs?: number;
  /** Signal ready anyway this long after spawn if the instructions never show up. */
  readyFallbackMs?: number;
  /** SIGKILL this long after SIGTERM. */
  killGraceMs?: number;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const PROGRESS_RE = /(\d{1,3})%\s*\|/g;
const MAX_TAIL = 8192;

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("***");
  return out.replace(/\d{4}-[0-9a-f]{32}/g, "***").replace(/--pass\s+\S+/g, "--pass ***");
}

function lastErrorLine(tail: string, secrets: string[]): string | undefined {
  const lines = tail
    .replace(ANSI_RE, "")
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !(l.includes("%") && l.includes("|")));
  const last = lines[lines.length - 1];
  return last ? redact(last, secrets).slice(0, 200) : undefined;
}

/** Spawns the croc binary at `path`. */
export function realCrocRunner(path: string, options: RealCrocOptions = {}): CrocRunner {
  const readyGraceMs = options.readyGraceMs ?? 500;
  const readyFallbackMs = options.readyFallbackMs ?? 10_000;
  const killGraceMs = options.killGraceMs ?? 2000;
  const globalArgs = (o: CrocCommon): string[] => [
    "--yes",
    "--overwrite",
    "--disable-clipboard",
    "--relay",
    o.relay,
    "--pass",
    o.pass,
  ];

  function run(args: string[], o: CrocCommon, cwd: string, onOutput?: (all: string) => void): CrocJob {
    let child: ChildProcess;
    let killed = false;
    let tail = "";
    let lastPct = -1;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<CrocExit>((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, CROC_SECRET: o.code };
      delete env.CROC_PASS;
      delete env.CROC_RELAY;
      try {
        child = spawn(path, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch (e) {
        resolve({ code: null, killed: false, error: `cannot start croc: ${(e as Error).message}` });
        return;
      }
      let settled = false;
      const finish = (r: CrocExit) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        resolve(r);
      };
      const onData = (d: Buffer) => {
        const s = d.toString("utf8");
        tail = (tail + s).slice(-MAX_TAIL);
        if (o.onProgress) {
          let m: RegExpExecArray | null;
          let pct = -1;
          PROGRESS_RE.lastIndex = 0;
          while ((m = PROGRESS_RE.exec(s))) pct = Number(m[1]);
          if (pct >= 0 && pct <= 100 && pct !== lastPct) {
            lastPct = pct;
            o.onProgress(pct / 100);
          }
        }
        onOutput?.(tail);
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      child.on("error", (e) => {
        finish({ code: null, killed, error: `cannot run croc: ${(e as NodeJS.ErrnoException).code ?? e.message}` });
      });
      child.on("close", (code) => {
        finish({ code: killed ? null : code, killed, error: code === 0 ? undefined : lastErrorLine(tail, [o.code, o.pass]) });
      });
    });
    return {
      done,
      kill() {
        if (killed || !child || child.exitCode !== null || child.signalCode !== null) return;
        killed = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, killGraceMs);
        killTimer.unref?.();
      },
    };
  }

  return {
    send(o) {
      let ready = false;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const fire = () => {
        if (ready) return;
        ready = true;
        o.onReady();
      };
      const fallback = setTimeout(fire, readyFallbackMs);
      const job = run([...globalArgs(o), "send", "--no-local", basename(o.file)], o, join(o.file, ".."), (all) => {
        if (!ready && !graceTimer && all.includes("CROC_SECRET=")) graceTimer = setTimeout(fire, readyGraceMs);
      });
      void job.done.then(() => {
        ready = true;
        clearTimeout(fallback);
        if (graceTimer) clearTimeout(graceTimer);
      });
      return job;
    },
    receive(o) {
      return run([...globalArgs(o), "--out", o.outDir], o, o.outDir);
    },
  };
}

// ------------------------------------------------------------------ fake

export interface FakeCrocRunner extends CrocRunner {
  /** The next N rendezvous fail on both sides (exit 1). */
  failNext: number;
  /** The next N rendezvous deliver a corrupted copy. */
  corruptNext: number;
  /** While true, matched transfers wait until release(). */
  hold: boolean;
  release(): void;
  /** The receiver writes the file but never exits (until killed); the sender exits 0. */
  hangAfterWrite: boolean;
  /** relay → password the fake relay accepts. Unknown relays accept anything. */
  passwords: Map<string, string>;
  /** Live jobs. */
  active(): number;
  /** Completed rendezvous count. */
  transfers: number;
  /** Every spawn, for assertions. */
  spawned: { kind: "send" | "receive"; relay: string }[];
}

interface FakeSender {
  file: string;
  pass: string;
  finish(r: CrocExit): void;
  alive: boolean;
}

/** In-process croc stand-in: senders and receivers rendezvous on relay+code. Share one instance between peers. */
export function fakeCrocRunner(): FakeCrocRunner {
  const rooms = new Map<string, FakeSender>();
  const live = new Set<object>();
  const held: (() => void)[] = [];
  const key = (relay: string, code: string) => `${relay}\n${code}`;

  function job(): { job: CrocJob; finish(r: CrocExit): void; onKill(fn: () => void): void; alive(): boolean } {
    let resolve!: (r: CrocExit) => void;
    let settled = false;
    let killHook: (() => void) | undefined;
    const token = {};
    live.add(token);
    const done = new Promise<CrocExit>((r) => (resolve = r));
    const finish = (r: CrocExit) => {
      if (settled) return;
      settled = true;
      live.delete(token);
      resolve(r);
    };
    return {
      job: {
        done,
        kill() {
          if (settled) return;
          killHook?.();
          finish({ code: null, killed: true });
        },
      },
      finish,
      onKill(fn) {
        killHook = fn;
      },
      alive: () => !settled,
    };
  }

  const fake: FakeCrocRunner = {
    failNext: 0,
    corruptNext: 0,
    hold: false,
    hangAfterWrite: false,
    passwords: new Map(),
    transfers: 0,
    spawned: [],
    active: () => live.size,
    release() {
      fake.hold = false;
      for (const fn of held.splice(0)) fn();
    },
    send(o) {
      fake.spawned.push({ kind: "send", relay: o.relay });
      const j = job();
      const required = fake.passwords.get(o.relay);
      if (required !== undefined && required !== o.pass) {
        setImmediate(() => j.finish({ code: 1, killed: false, error: "could not connect: bad password" }));
        return j.job;
      }
      const k = key(o.relay, o.code);
      const s: FakeSender = { file: o.file, pass: o.pass, finish: j.finish, alive: true };
      rooms.set(k, s);
      j.onKill(() => {
        s.alive = false;
        if (rooms.get(k) === s) rooms.delete(k);
      });
      setImmediate(() => j.alive() && o.onReady());
      return j.job;
    },
    receive(o) {
      fake.spawned.push({ kind: "receive", relay: o.relay });
      const j = job();
      let cancelled = false;
      j.onKill(() => (cancelled = true));
      setImmediate(() => {
        if (cancelled) return;
        const required = fake.passwords.get(o.relay);
        if (required !== undefined && required !== o.pass) {
          j.finish({ code: 1, killed: false, error: "could not connect: bad password" });
          return;
        }
        const k = key(o.relay, o.code);
        const s = rooms.get(k);
        if (!s || !s.alive) {
          j.finish({ code: 1, killed: false, error: "room (secure channel) not ready, maybe peer disconnected" });
          return;
        }
        const go = () => {
          if (cancelled) {
            return;
          }
          if (!s.alive) {
            j.finish({ code: 1, killed: false, error: "peer disconnected" });
            return;
          }
          rooms.delete(k);
          s.alive = false;
          if (fake.failNext > 0) {
            fake.failNext--;
            s.finish({ code: 1, killed: false, error: "could not secure channel" });
            j.finish({ code: 1, killed: false, error: "problem with decoding" });
            return;
          }
          mkdirSync(o.outDir, { recursive: true });
          const dest = join(o.outDir, basename(s.file));
          copyFileSync(s.file, dest);
          if (fake.corruptNext > 0) {
            fake.corruptNext--;
            corruptFirstByte(dest);
          }
          o.onProgress?.(1);
          fake.transfers++;
          s.finish({ code: 0, killed: false });
          if (fake.hangAfterWrite) return; // stays alive until killed
          j.finish({ code: 0, killed: false });
        };
        if (fake.hold) {
          held.push(go);
          // if the sender dies while held, the receiver fails like real croc would
          const poll = setInterval(() => {
            if (cancelled || !j.alive()) clearInterval(poll);
            else if (!s.alive) {
              clearInterval(poll);
              j.finish({ code: 1, killed: false, error: "peer disconnected" });
            }
          }, 5);
        } else go();
      });
      return j.job;
    },
  };
  return fake;
}

function corruptFirstByte(file: string): void {
  const fd = openSync(file, "r+");
  try {
    const b = Buffer.alloc(1);
    const n = readSync(fd, b, 0, 1, 0);
    b[0] = n === 0 ? 0x41 : b[0] ^ 0xff;
    writeSync(fd, b, 0, 1, 0);
  } finally {
    closeSync(fd);
  }
}
