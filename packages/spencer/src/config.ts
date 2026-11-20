import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
  /** Loop guard (PROTOCOL.md §7.2), standard trust: max hop of a message that still gets an automatic reply. 0 = no cap. */
  maxHops: number;
  /** The same for channels with full trust. 0 = no cap (the turn budget below still applies). */
  maxHopsFullTrust: number;
  /** Automatic replies per channel per minute / per hour, standard trust. */
  repliesPerMinute: number;
  repliesPerHour: number;
  /** The same for channels with full trust. */
  repliesPerMinuteFullTrust: number;
  repliesPerHourFullTrust: number;
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
  http: { host: "127.0.0.1"; port: number };
  model: ModelConfig;
  /** `throttleUpload`: croc's --throttleUpload for sends (e.g. "500k"), null = unlimited. */
  croc: { path: string; relay: string | null; pass: string | null; allowLocal: boolean; throttleUpload: string | null };
  mcpServers: Record<string, McpServerConfig>;
  policy: Policy;
}

export const DEFAULT_POLICY: Policy = {
  maxHops: 8,
  maxHopsFullTrust: 0,
  repliesPerMinute: 6,
  repliesPerHour: 60,
  repliesPerMinuteFullTrust: 20,
  repliesPerHourFullTrust: 200,
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
    http: { host: "127.0.0.1", port: 7420 },
    model: { provider: "anthropic", modelId: "claude-sonnet-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
    croc: { path: "croc", relay: null, pass: null, allowLocal: false, throttleUpload: null },
    mcpServers: {},
    policy: { ...DEFAULT_POLICY },
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
    http: { host: "127.0.0.1", port: Number(raw.http?.port ?? d.http.port) },
    model: (raw.model as ModelConfig) ?? d.model,
    croc: { ...d.croc, ...(raw.croc ?? {}) },
    mcpServers: (raw.mcpServers as Record<string, McpServerConfig>) ?? {},
    policy: { ...d.policy, ...(raw.policy ?? {}) },
  };
  if (process.env.SPENCER_PORT) cfg.http.port = Number(process.env.SPENCER_PORT);
  if (!Number.isInteger(cfg.http.port) || cfg.http.port < 0 || cfg.http.port > 65535) throw new Error("invalid http.port");
  if (!/^wss?:\/\//.test(cfg.relay)) throw new Error("relay must be a ws:// or wss:// URL");
  if (cfg.croc.throttleUpload !== null && !/^\d+[kKmMgG]?$/.test(String(cfg.croc.throttleUpload))) {
    throw new Error('croc.throttleUpload must look like "500k" (or null)');
  }
  for (const k of [
    "maxHops",
    "maxHopsFullTrust",
    "repliesPerMinute",
    "repliesPerHour",
    "repliesPerMinuteFullTrust",
    "repliesPerHourFullTrust",
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
