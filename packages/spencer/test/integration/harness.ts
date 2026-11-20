/**
 * Integration harness: a real Spencer relay, a real croc relay (the pinned .bin/croc), and a small client for the
 * daemon's local HTTP API. Nothing here is faked except the LLM (`model: {provider: "fake"}`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay, type RelayHandle } from "../../../relay/src/index.ts";
import type { ChannelMessage, OwnerItem, Transfer } from "../../src/contracts.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const CROC = join(ROOT, ".bin/croc");
export const MAIN = join(ROOT, "packages/spencer/src/main.ts");
export const haveCroc = existsSync(CROC);

export const testLog = process.env.SPENCER_TEST_LOG ? (m: string) => console.error(`  · ${m}`) : (_m: string) => {};

export function tempDir(prefix: string): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` (sync or async) until it returns a truthy value. */
export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 15_000, everyMs = 50): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${lastErr ? ` (last error: ${(lastErr as Error).message})` : ""}`);
    await sleep(everyMs);
  }
}

// ------------------------------------------------------------------ ports

function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => res(true)));
  });
}

/** `n` consecutive free ports (croc binds 0.0.0.0). */
export async function freePorts(n: number): Promise<number[]> {
  for (let tries = 0; tries < 100; tries++) {
    const base = 20000 + Math.floor(Math.random() * 40000);
    const ports = Array.from({ length: n }, (_, i) => base + i);
    let ok = true;
    for (const p of ports) if (!(await portFree(p, "0.0.0.0"))) ok = false;
    if (ok) return ports;
  }
  throw new Error("no free port range");
}

export async function freePort(): Promise<number> {
  return (await freePorts(1))[0]!;
}

export function canConnect(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      res(true);
    });
    s.once("error", () => res(false));
  });
}

// ------------------------------------------------------------------ croc relay

export interface CrocRelay {
  addr: string;
  pass: string;
  proc: ChildProcess;
  stop(): Promise<void>;
}

export async function startCrocRelay(): Promise<CrocRelay> {
  const ports = await freePorts(5);
  const pass = randomBytes(12).toString("hex");
  const proc = spawn(CROC, ["--pass", pass, "relay", "--ports", ports.join(",")], { stdio: "ignore" });
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const gone = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGKILL");
    await gone;
  };
  try {
    await waitFor(async () => {
      if (proc.exitCode !== null) throw new Error("croc relay exited");
      return canConnect(ports[0]!);
    }, "croc relay", 10_000);
    // The relay opens its data ports right after the first one.
    await sleep(200);
  } catch (e) {
    await stop();
    throw e;
  }
  return { addr: `127.0.0.1:${ports[0]}`, pass, proc, stop };
}

// ------------------------------------------------------------------ Spencer relay

export interface TestRelay {
  url: string;
  port: number;
  handle: RelayHandle | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** A Spencer relay on a fixed port (so it can be stopped and restarted at the same URL). */
export async function testRelay(dir: string, croc: { addr: string; pass: string } | undefined): Promise<TestRelay> {
  const port = await freePort();
  const r: TestRelay = {
    url: `ws://127.0.0.1:${port}/ws`,
    port,
    handle: undefined,
    async start() {
      if (r.handle) return;
      r.handle = await startRelay({
        host: "127.0.0.1",
        port,
        dbPath: join(dir, "relay.sqlite"),
        ...(croc ? { crocRelay: croc.addr, crocPass: croc.pass } : {}),
        log: testLog,
      });
    },
    async stop() {
      const h = r.handle;
      r.handle = undefined;
      await h?.close();
    },
  };
  await r.start();
  return r;
}

// ------------------------------------------------------------------ API client

export interface ApiState {
  me: { id: string; name: string; fingerprint: string };
  relay: { url: string; connected: boolean };
  channels: { id: string; kind: string; name: string; members: { id: string; name?: string; me: boolean }[] }[];
  transfers: Transfer[];
  ownerBusy: boolean;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

/** The local HTTP API, used the way the web UI uses it (token header, JSON). */
export class Api {
  port: number;
  token: string;
  constructor(port: number, token: string) {
    this.port = port;
    this.token = token;
  }

  async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method,
      headers: { "X-Spencer-Token": this.token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, `${method} ${path}: ${res.status} ${json?.error ?? text}`);
    return json as T;
  }

  state = () => this.req<ApiState>("GET", "/api/state");
  createInvite = (kind: "direct" | "group", name: string) =>
    this.req<{ link: string; channel: { id: string } }>("POST", "/api/invites", { kind, name });
  acceptInvite = (link: string) => this.req<{ channel: { id: string } }>("POST", "/api/invites/accept", { link });
  say = (ch: string, text: string, mentions?: string[]) =>
    this.req<{ id: string }>("POST", `/api/channels/${ch}/messages`, { text, ...(mentions ? { mentions } : {}) });
  messages = async (ch: string, limit = 200, before?: string) =>
    (await this.req<{ items: ChannelMessage[] }>("GET", `/api/channels/${ch}/messages?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`))
      .items;
  ownerSend = (text: string) => this.req<{ submissionId: string }>("POST", "/api/owner/messages", { text });
  owner = async (limit = 200) => (await this.req<{ items: OwnerItem[] }>("GET", `/api/owner/messages?limit=${limit}`)).items;
  transfers = async () => (await this.req<{ items: Transfer[] }>("GET", "/api/transfers")).items;
  transfer = (tid: string) => this.req<Transfer>("GET", `/api/transfers/${tid}`);
  sendFile = (ch: string, path: string, to?: string) => this.req<Transfer>("POST", "/api/transfers", { ch, path, ...(to ? { to } : {}) });
  transferAction = (tid: string, action: "approve" | "deny" | "accept" | "decline" | "cancel") =>
    this.req<Transfer>("POST", `/api/transfers/${tid}/${action}`);
}

// ------------------------------------------------------------------ processes

/** Pids of live croc processes whose cwd or argv points into `dir` (a test's data dirs), via /proc. */
export function crocProcsUnder(dir: string): number[] {
  const out: number[] = [];
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return out;
  }
  for (const p of pids) {
    try {
      const argv = readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0");
      if (!argv[0] || !/(^|\/)croc$/.test(argv[0])) continue;
      let cwd = "";
      try {
        cwd = readlinkSync(`/proc/${p}/cwd`);
      } catch {
        /* gone */
      }
      if (cwd.startsWith(dir) || argv.some((a) => a.startsWith(dir))) out.push(Number(p));
    } catch {
      /* gone */
    }
  }
  return out;
}

/** SIGKILLs `pids` and waits (up to 5 s) until they are gone. */
export async function killAll(pids: number[]): Promise<void> {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  await waitFor(() => !pids.some(alive), "killed processes to exit", 5000, 20).catch(() => {});
}
