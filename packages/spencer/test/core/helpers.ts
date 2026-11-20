import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { request as httpRequest } from "node:http";
import { startRelay } from "../../../relay/src/index.ts";
import { Daemon, type DaemonOptions } from "../../src/daemon.ts";
import type {
  AgentService,
  CoreServices,
  IncomingChat,
  OutgoingChat,
  OwnerItem,
  Transfer,
  TransferDeps,
  TransferRequest,
  TransferService,
} from "../../src/contracts.ts";
import type { FileBody } from "@spencer/protocol";

export const quietLog = (_m: string): void => {};
export const log = process.env.SPENCER_TEST_LOG ? (m: string) => console.error(`  · ${m}`) : quietLog;

export function tempDir(prefix = "spencer-core-"): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export type Relay = Awaited<ReturnType<typeof startRelay>>;

export async function relayAt(dbDir: string, port = 0): Promise<Relay> {
  return startRelay({ host: "127.0.0.1", port, dbPath: join(dbDir, "relay.sqlite"), crocRelay: "127.0.0.1:9009", crocPass: "pass", log: quietLog });
}

export async function waitFor<T>(fn: () => T | undefined | null | false, what = "condition", timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- stubs

export class StubAgent implements AgentService {
  core: CoreServices;
  peerChats: IncomingChat[] = [];
  outgoing: OutgoingChat[] = [];
  ownerSends: string[] = [];
  notes: string[] = [];
  changed: string[] = [];
  started = false;
  stopped = false;
  /** Optional hook: return a note, or throw to simulate a crash before the hand-off. */
  onChat?: (m: IncomingChat) => { note?: string } | Promise<{ note?: string }>;

  constructor(core: CoreServices) {
    this.core = core;
  }
  async start() {
    this.started = true;
  }
  async stop() {
    this.stopped = true;
  }
  async onPeerChat(msg: IncomingChat) {
    const r = this.onChat ? await this.onChat(msg) : {};
    this.peerChats.push(msg);
    return r;
  }
  async onOutgoingChat(msg: OutgoingChat) {
    this.outgoing.push(msg);
  }
  async ownerSend(text: string) {
    this.ownerSends.push(text);
    return { submissionId: `sub-${this.ownerSends.length}` };
  }
  async ownerTranscript(_limit: number): Promise<OwnerItem[]> {
    return this.ownerSends.map((t, i) => ({ id: `u${i}`, role: "user" as const, text: t, ts: 0 }));
  }
  ownerBusy() {
    return false;
  }
  async ownerNote(text: string) {
    this.notes.push(text);
  }
  async channelChanged(ch: string) {
    this.changed.push(ch);
  }
  mcpStatus() {
    return [];
  }
}

export class StubTransfers implements TransferService {
  deps: TransferDeps;
  bodies: { ch: string; from: string; body: FileBody }[] = [];
  requests: { ch: string; req: TransferRequest }[] = [];
  constructor(deps: TransferDeps) {
    this.deps = deps;
  }
  async start() {}
  async stop() {}
  async request(ch: string, req: TransferRequest): Promise<Transfer> {
    this.requests.push({ ch, req });
    const now = Date.now();
    return {
      tid: "t".repeat(22),
      ch,
      direction: "out",
      peer: req.to ?? this.deps.peers(ch)[0] ?? "",
      name: req.path,
      size: 0,
      sha256: "0".repeat(64),
      state: "awaiting_approval",
      attempt: 0,
      initiatedBy: req.initiatedBy,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 1000,
    };
  }
  private nope(): Transfer {
    throw Object.assign(new Error("unknown transfer"), { status: 404 });
  }
  approve() {
    return this.nope();
  }
  deny() {
    return this.nope();
  }
  accept() {
    return this.nope();
  }
  decline() {
    return this.nope();
  }
  cancel() {
    return this.nope();
  }
  async onBody(ch: string, from: string, body: FileBody) {
    this.bodies.push({ ch, from, body });
  }
  list() {
    return [];
  }
  get() {
    return undefined;
  }
}

export interface TestNode {
  daemon: Daemon;
  dir: string;
  agent(): StubAgent;
  transfers(): StubTransfers;
  /** All StubAgents this node had (one per start). */
  agents: StubAgent[];
  restart(): Promise<void>;
}

export const FAST = {
  relay: { minBackoffMs: 30, maxBackoffMs: 300, requestTimeoutMs: 3000, handshakeTimeoutMs: 3000 },
  outboxMinBackoffMs: 50,
  outboxMaxBackoffMs: 300,
};

export async function startNode(
  dir: string,
  relayUrl: string,
  name: string,
  extra: Partial<DaemonOptions> & { beforeStart?: (agent: StubAgent) => void } = {},
): Promise<TestNode> {
  const agents: StubAgent[] = [];
  const transfers: StubTransfers[] = [];
  const mk = () =>
    new Daemon({
      dataDir: dir,
      config: { name, relay: relayUrl, http: { host: "127.0.0.1", port: 0 }, model: { provider: "fake" } },
      agentFactory: (core) => {
        const a = new StubAgent(core);
        extra.beforeStart?.(a);
        agents.push(a);
        return a;
      },
      transferFactory: (deps) => {
        const t = new StubTransfers(deps);
        transfers.push(t);
        return t;
      },
      log,
      webRoot: null,
      tuning: FAST,
      ...extra,
    });
  const node: TestNode = {
    daemon: mk(),
    dir,
    agents,
    agent: () => agents[agents.length - 1],
    transfers: () => transfers[transfers.length - 1],
    async restart() {
      await node.daemon.stop();
      node.daemon = mk();
      await node.daemon.start();
    },
  };
  await node.daemon.start();
  return node;
}

// ---------------------------------------------------------------- raw HTTP

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json(): any;
}

export function http(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown; host?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : Buffer.from(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          Host: opts.host ?? `127.0.0.1:${port}`,
          ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}),
          ...(opts.headers ?? {}),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
