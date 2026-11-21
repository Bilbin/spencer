import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { normalizeRelayUrl } from "@spencer/protocol";

export type P2pConfig = { mode: "files" | "off"; hideLocalAddresses: boolean; minFileBytes: number; stun: string[] };

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export type ModelConfig =
  | { provider: "fake" }
  /** Built-in pi-ai provider id (anthropic, openai, openrouter, google, xai, groq, …). */
  | { provider: string; modelId: string; apiKeyEnv?: string; apiKey?: string; baseUrl?: string; thinking?: ThinkingLevel }
  | {
      provider: "openai-compatible";
      baseUrl: string;
      modelId: string;
      apiKeyEnv?: string;
      apiKey?: string;
      contextWindow?: number;
      maxTokens?: number;
      /** Reasoning effort, sent as `reasoning_effort` (needs a reasoning model). Absent or "off": none. */
      thinking?: ThinkingLevel;
    };

export type McpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string; disabled?: boolean }
  | { url: string; headers?: Record<string, string>; disabled?: boolean };

export interface Policy {
  /**
   * Loop guard (PROTOCOL.md §7.2). Standard trust: the highest hop that still gets an automatic reply (a backstop that
   * old Spencers understand too; 0 = no cap). The turn budget below is the main limit.
   */
  maxHops: number;
  /** The same for channels with full trust. 0 = no cap. */
  maxHopsFullTrust: number;
  /** Automatic replies in a channel since a person last wrote there, standard trust; then the channel pauses and asks. 0 = no limit. */
  maxAgentTurns: number;
  maxAgentTurnsFullTrust: number;
  /** Automatic replies per channel per minute (skipped above it) and per hour / day (pauses and asks), standard trust. */
  repliesPerMinute: number;
  repliesPerHour: number;
  repliesPerDay: number;
  /** The same for channels with full trust. */
  repliesPerMinuteFullTrust: number;
  repliesPerHourFullTrust: number;
  repliesPerDayFullTrust: number;
  /** Follow-ups (schedule_followup) one conversation may have pending at once. */
  maxPendingFollowups: number;
  /** How many times in a row a follow-up may schedule the next one (polling a long task). */
  maxFollowupChain: number;
  autoAcceptIncomingFiles: boolean;
  maxIncomingFileBytes: number;
  requireApprovalForOutgoingFiles: boolean;
  ownerCodingTools: boolean;
  transferTtlHours: number;
  maxTransferAttempts: number;
}

export interface SpencerConfig {
  name: string;
  relay: string;
  p2p: P2pConfig;
  http: { host: "127.0.0.1"; port: number };
  model: ModelConfig;
  /** `throttleUpload`: croc's --throttleUpload for sends (e.g. "500k"), null = unlimited. */
  croc: { path: string; relay: string | null; pass: string | null; allowLocal: boolean; throttleUpload: string | null };
  mcpServers: Record<string, McpServerConfig>;
  policy: Policy;
  /** Model sign-in settings. `githubClientId`: Spencer's GitHub OAuth app for "Sign in with GitHub" (Copilot). */
  auth: { githubClientId?: string };
}

export const DEFAULT_POLICY: Policy = {
  maxHops: 40,
  maxHopsFullTrust: 0,
  maxAgentTurns: 20,
  maxAgentTurnsFullTrust: 50,
  repliesPerMinute: 6,
  repliesPerHour: 60,
  repliesPerDay: 300,
  repliesPerMinuteFullTrust: 20,
  repliesPerHourFullTrust: 200,
  repliesPerDayFullTrust: 1000,
  maxPendingFollowups: 5,
  maxFollowupChain: 12,
  autoAcceptIncomingFiles: true,
  maxIncomingFileBytes: 512 * 1024 * 1024,
  requireApprovalForOutgoingFiles: true,
  ownerCodingTools: true,
  transferTtlHours: 24,
  maxTransferAttempts: 5,
};

export function defaultConfig(): SpencerConfig {
  return {
    name: "Spencer",
    relay: "wss://spencer.pjalv.com/ws",
    p2p: { mode: "files", hideLocalAddresses: true, minFileBytes: 4 * 1024 * 1024, stun: [] },
    http: { host: "127.0.0.1", port: 7420 },
    model: { provider: "anthropic", modelId: "claude-sonnet-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
    croc: { path: "croc", relay: null, pass: null, allowLocal: false, throttleUpload: null },
    mcpServers: {},
    policy: { ...DEFAULT_POLICY },
    auth: {},
  };
}

export function defaultDataDir(): string {
  return process.env.SPENCER_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "spencer");
}

/** Merge a user config over defaults. Unknown keys are kept out. */
export function resolveConfig(raw: Partial<SpencerConfig> & Record<string, unknown>): SpencerConfig {
  const d = defaultConfig();
  const cfg: SpencerConfig = {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 100) : d.name,
    relay: typeof raw.relay === "string" ? raw.relay : d.relay,
    p2p: { ...d.p2p, ...(raw.p2p ?? {}) },
    http: { host: "127.0.0.1", port: Number(raw.http?.port ?? d.http.port) },
    model: (raw.model as ModelConfig) ?? d.model,
    croc: { ...d.croc, ...(raw.croc ?? {}) },
    mcpServers: (raw.mcpServers as Record<string, McpServerConfig>) ?? {},
    policy: { ...d.policy, ...(raw.policy ?? {}) },
    auth: {},
  };
  const auth = raw.auth as Record<string, unknown> | undefined;
  if (auth && typeof auth.githubClientId === "string" && auth.githubClientId.trim()) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(auth.githubClientId.trim())) throw new Error("auth.githubClientId does not look like a GitHub OAuth client id");
    cfg.auth.githubClientId = auth.githubClientId.trim();
  }
  if (process.env.SPENCER_PORT) cfg.http.port = Number(process.env.SPENCER_PORT);
  if (!Number.isInteger(cfg.http.port) || cfg.http.port < 0 || cfg.http.port > 65535) throw new Error("invalid http.port");
  cfg.relay = normalizeRelayUrl(process.env.SPENCER_RELAY || cfg.relay);
  const p = cfg.p2p;
  if ((p.mode !== "files" && p.mode !== "off") || typeof p.hideLocalAddresses !== "boolean" || !Number.isSafeInteger(p.minFileBytes) || p.minFileBytes < 0 || !Array.isArray(p.stun) || p.stun.length > 16 || !p.stun.every(x => { if (typeof x !== "string") return false; const m = /^(?:\[[^\[\]]+\]|[^:\s]+):(\d+)$/.exec(x); return !!m && Number(m[1]) >= 1 && Number(m[1]) <= 65535; })) throw new Error("invalid p2p configuration");
  if (cfg.croc.throttleUpload !== null && !/^\d+[kKmMgG]?$/.test(String(cfg.croc.throttleUpload))) {
    throw new Error('croc.throttleUpload must look like "500k" (or null)');
  }
  for (const k of [
    "maxHops",
    "maxHopsFullTrust",
    "maxAgentTurns",
    "maxAgentTurnsFullTrust",
    "repliesPerMinute",
    "repliesPerHour",
    "repliesPerDay",
    "repliesPerMinuteFullTrust",
    "repliesPerHourFullTrust",
    "repliesPerDayFullTrust",
    "maxPendingFollowups",
    "maxFollowupChain",
  ] as const) {
    if (!Number.isSafeInteger(cfg.policy[k]) || cfg.policy[k] < 0) throw new Error(`policy.${k} must be a non-negative integer`);
  }
  for (const [name, s] of Object.entries(cfg.mcpServers)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error(`invalid MCP server name: ${name}`);
    if (!("command" in s) && !("url" in s)) throw new Error(`MCP server ${name} needs command or url`);
  }
  return cfg;
}

export function loadConfig(dataDir: string): SpencerConfig {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "config.json");
  if (!existsSync(file)) {
    const cfg = defaultConfig();
    writeFileSync(file, JSON.stringify({ name: cfg.name, relay: cfg.relay, model: cfg.model, mcpServers: {} }, null, 2) + "\n", {
      mode: 0o600,
    });
    return cfg;
  }
  return resolveConfig(JSON.parse(readFileSync(file, "utf8")));
}
