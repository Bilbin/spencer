/**
 * GitHub Copilot as a model provider, signed in the way OpenCode does it (MIT,
 * github.com/anomalyco/opencode, packages/core/src/plugin/provider/github-copilot.ts):
 *
 *  1. GitHub's OAuth device flow (scope `read:user`) with *Spencer's own* OAuth app: the person gets a short
 *     code to enter at github.com/login/device. No client secret is involved.
 *  2. `api.github.com/copilot_internal/user` confirms the account has Copilot and names its API endpoint
 *     (`endpoints.api`: individual, business or enterprise).
 *  3. The GitHub token is then sent as-is (Bearer) to that endpoint; there is no token exchange, and OAuth-app
 *     tokens do not expire.
 *
 * Requests identify as Spencer (User-Agent `spencer/<version>`), not as VS Code: pi-ai's built-in Copilot
 * provider borrows VS Code's client id and editor headers, which we do not.
 *
 * Instead of the device flow, a person already signed in to the GitHub Copilot CLI can reuse that sign-in
 * (`~/.copilot/config.json`). Some Business/Enterprise policies give third-party OAuth apps (like Spencer's)
 * only a few legacy models, while GitHub's own clients get the full list.
 *
 * The provider id stays `github-copilot` so pi-ai's per-API Copilot handling (Bearer auth, X-Initiator, vision
 * header) applies; models route per their `api` (Anthropic Messages for Claude, Responses for GPT, …).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProvider, type Api, type Model, type OAuthAuth, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { osCopilotKeyring, type CopilotKeyring } from "./copilot-keyring.ts";

export { osCopilotKeyring, parseDbusUnixAddress, type CopilotKeyring, type KeyringLookupResult } from "./copilot-keyring.ts";

export const COPILOT_PROVIDER = "github-copilot";

/**
 * Spencer's GitHub OAuth app (Device Flow enabled). `auth.githubClientId` in config.json or
 * SPENCER_GITHUB_CLIENT_ID can override it.
 */
export const DEFAULT_GITHUB_CLIENT_ID = "Ov23lihuugW3NG0Yt8b5";

const GITHUB = "https://github.com";
const GITHUB_API = "https://api.github.com";
export const COPILOT_USER_API_VERSION = "2025-04-01";
export const COPILOT_API_VERSION = "2026-08-01";
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Re-check the account (plan, endpoint, models) this often; the token itself does not expire. */
const RECHECK_MS = 6 * 60 * 60 * 1000;
/** Used first, in order, when Spencer picks a model after sign-in. */
export const PREFERRED_COPILOT_MODELS = [
  "claude-sonnet-5.5",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "gpt-6.1-terra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6-astra",
  "gpt-5.6-luna",
  "gpt-5.3-codex",
  "gpt-5",
  "gpt-4.1",
  "claude-haiku-4.5",
  "gpt-4o",
  "gpt-4o-mini",
  "claude-opus-5.5",
];

export function userAgent(): string {
  return `spencer/${process.env.SPENCER_BUILD ?? "dev"}`;
}

export function githubClientId(configured?: string): string | undefined {
  const id = (process.env.SPENCER_GITHUB_CLIENT_ID || configured || DEFAULT_GITHUB_CLIENT_ID).trim();
  return id && CLIENT_ID_RE.test(id) ? id : undefined;
}

/** A chat model discovered live from the account's Copilot `/models` endpoint. */
export interface CopilotDiscoveredModel {
  id: string;
  name: string;
  api: "anthropic-messages" | "openai-responses" | "openai-completions";
  reasoning?: boolean;
  vision?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** The saved credential: an OAuth credential whose access and refresh are both the GitHub token. */
export interface CopilotCredential extends OAuthCredential {
  login: string;
  plan?: string;
  apiBase: string;
  availableModelIds?: string[];
  availableModels?: CopilotDiscoveredModel[];
  modelsRefreshedAt?: number;
  source: "device" | "copilot-cli";
}

export class CopilotAuthError extends Error {
  /** "revoked": the token no longer works; "no_copilot": the account has no Copilot. */
  readonly code: "revoked" | "no_copilot" | "network" | "denied" | "expired" | "failed";
  constructor(code: CopilotAuthError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

async function getJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new CopilotAuthError("network", `could not reach ${new URL(url).host}`);
  }
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

// ------------------------------------------------------------------ device flow

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: number;
}

export async function startDeviceFlow(clientId: string, signal?: AbortSignal): Promise<DeviceCode> {
  const { status, body } = await getJson(
    `${GITHUB}/login/device/code`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent() },
      body: new URLSearchParams({ client_id: clientId, scope: "read:user" }),
    },
    signal,
  );
  const d = rec(body);
  if (status !== 200 || !d) throw new CopilotAuthError("failed", `GitHub refused the sign-in request (HTTP ${status})`);
  if (typeof d.error === "string") {
    const hint = d.error === "device_flow_disabled" ? ": enable Device Flow in the OAuth app's settings" : "";
    throw new CopilotAuthError("failed", `GitHub refused the sign-in request (${d.error})${hint}`);
  }
  const { device_code, user_code, verification_uri, interval, expires_in } = d;
  if (typeof device_code !== "string" || typeof user_code !== "string" || typeof verification_uri !== "string" || typeof expires_in !== "number") {
    throw new CopilotAuthError("failed", "GitHub sent an unexpected sign-in response");
  }
  // Only ever send people to GitHub itself.
  let uri: URL;
  try {
    uri = new URL(verification_uri);
  } catch {
    throw new CopilotAuthError("failed", "GitHub sent an unexpected sign-in link");
  }
  if (uri.protocol !== "https:" || uri.hostname !== "github.com") throw new CopilotAuthError("failed", "GitHub sent an unexpected sign-in link");
  return {
    deviceCode: device_code,
    userCode: user_code,
    verificationUri: uri.href,
    intervalSeconds: typeof interval === "number" && interval > 0 ? interval : 5,
    expiresAt: Date.now() + expires_in * 1000,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Added to every poll wait. GitHub answers `slow_down` (and withholds the token) when a poll arrives right at the
 * interval, then raises the interval by 5s; polling exactly on time hits that again on every request, so an
 * approved sign-in never completes. OpenCode and the GitHub CLI pad the interval the same way.
 */
export const DEVICE_POLL_MARGIN_MS = 3_000;

/** Polls until the person approves (resolves with the GitHub token), denies, or the code expires. */
export async function pollDeviceFlow(clientId: string, device: DeviceCode, signal: AbortSignal): Promise<string> {
  let interval = device.intervalSeconds;
  for (;;) {
    await sleep(interval * 1000 + DEVICE_POLL_MARGIN_MS, signal);
    if (Date.now() > device.expiresAt) throw new CopilotAuthError("expired", "The code expired before it was entered. Start again.");
    let r: { status: number; body: unknown };
    try {
      r = await getJson(
        `${GITHUB}/login/oauth/access_token`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent() },
          body: new URLSearchParams({ client_id: clientId, device_code: device.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
        },
        signal,
      );
    } catch (e) {
      if (e instanceof CopilotAuthError && e.code === "network") continue; // keep waiting through a blip
      throw e;
    }
    const d = rec(r.body);
    if (d && typeof d.access_token === "string" && d.access_token) return d.access_token;
    const err = d && typeof d.error === "string" ? d.error : `HTTP ${r.status}`;
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      interval = typeof d?.interval === "number" ? d.interval : interval + 5;
      continue;
    }
    if (err === "access_denied") throw new CopilotAuthError("denied", "The sign-in was cancelled on GitHub.");
    if (err === "expired_token") throw new CopilotAuthError("expired", "The code expired before it was entered. Start again.");
    throw new CopilotAuthError("failed", `GitHub sign-in failed (${err})`);
  }
}

// ------------------------------------------------------------------ account and models

export interface CopilotAccount {
  login: string;
  plan?: string;
  apiBase: string;
}

/** Who the token belongs to and where their Copilot API lives. */
export async function copilotAccount(token: string, signal?: AbortSignal): Promise<CopilotAccount> {
  const { status, body } = await getJson(
    `${GITHUB_API}/copilot_internal/user`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": userAgent(),
        "X-GitHub-Api-Version": COPILOT_USER_API_VERSION,
      },
    },
    signal,
  );
  if (status === 401) throw new CopilotAuthError("revoked", "GitHub no longer accepts this sign-in. Sign in again.");
  const d = rec(body);
  if (status === 403 || status === 404 || (status === 200 && d?.chat_enabled === false)) {
    throw new CopilotAuthError("no_copilot", "This GitHub account doesn't have GitHub Copilot.");
  }
  if (status !== 200 || !d) throw new CopilotAuthError("failed", `GitHub could not check the Copilot subscription (HTTP ${status})`);
  const api = rec(d.endpoints)?.api;
  let apiBase = "https://api.githubcopilot.com";
  if (typeof api === "string") {
    try {
      const u = new URL(api);
      // Only Copilot's own hosts: the token goes there.
      if (u.protocol === "https:" && (u.hostname === "githubcopilot.com" || u.hostname.endsWith(".githubcopilot.com"))) apiBase = u.origin;
    } catch {
      /* keep the default */
    }
  }
  return {
    login: typeof d.login === "string" ? d.login : "",
    ...(typeof d.copilot_plan === "string" ? { plan: d.copilot_plan } : {}),
    apiBase,
  };
}

/** Matches OpenCode's Copilot endpoint selection (`supported_endpoints`, then model-family fallback). */
export function inferCopilotApi(id: string, endpoints: unknown): CopilotDiscoveredModel["api"] {
  const eps = Array.isArray(endpoints) ? endpoints.filter((e): e is string => typeof e === "string") : [];
  if (eps.includes("/v1/messages")) return "anthropic-messages";
  if (eps.includes("/responses")) return "openai-responses";
  if (eps.includes("/chat/completions")) return "openai-completions";
  if (id.startsWith("claude-")) return "anthropic-messages";
  const gpt = /^gpt-(\d+)/.exec(id);
  if (gpt !== null && Number(gpt[1]) >= 5 && !id.startsWith("gpt-5-mini")) return "openai-responses";
  if (id.startsWith("grok-") || id.startsWith("mai-code-")) return "openai-responses";
  return "openai-completions";
}

function inferReasoning(id: string, supports: Record<string, unknown> | undefined): boolean {
  if (supports?.adaptive_thinking === true || supports?.reasoning_effort === true || supports?.thinking === true) return true;
  return /^(o[1-9]|gpt-5|gpt-6|claude-(?:opus|sonnet|haiku|fable)-[4-9]|gemini-[2-9]|grok-[3-9])/.test(id);
}

/** Parses the JSON body of Copilot's `GET /models` response into chat models the account may use. */
export function parseCopilotModels(body: unknown): CopilotDiscoveredModel[] | undefined {
  const data = rec(body)?.data;
  if (!Array.isArray(data)) return undefined;
  const rows = data.flatMap((raw) => {
    const m = rec(raw);
    if (!m || typeof m.id !== "string" || !m.id.trim()) return [];
    const caps = rec(m.capabilities);
    const type = typeof caps?.type === "string" ? caps.type : undefined;
    if (type && type !== "chat") return [];
    const supports = rec(caps?.supports);
    if (supports?.tool_calls === false) return [];
    const limits = rec(caps?.limits);
    const ctx =
      typeof limits?.max_context_window_tokens === "number"
        ? limits.max_context_window_tokens
        : typeof limits?.max_prompt_tokens === "number"
          ? limits.max_prompt_tokens
          : undefined;
    const maxTokens = typeof limits?.max_output_tokens === "number" ? limits.max_output_tokens : undefined;
    const id = m.id.trim();
    const name = typeof m.name === "string" && m.name.trim() ? m.name.trim() : id;
    const reasoning = inferReasoning(id, supports);
    const vision = supports?.vision === true || caps?.vision === true;
    const model: CopilotDiscoveredModel = {
      id,
      name,
      api: inferCopilotApi(id, m.supported_endpoints),
      ...(reasoning ? { reasoning: true } : {}),
      ...(vision ? { vision: true } : {}),
      ...(ctx && ctx > 0 ? { contextWindow: ctx } : {}),
      ...(maxTokens && maxTokens > 0 ? { maxTokens } : {}),
    };
    return [{ model, picker: m.model_picker_enabled === true, policy: rec(m.policy)?.state }];
  });
  const picker = rows.filter((r) => r.picker && r.policy !== "disabled").map((r) => r.model);
  const chosen = picker.length ? picker : rows.filter((r) => r.policy !== "disabled").map((r) => r.model);
  const seen = new Set<string>();
  return chosen.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

/** Chat models the account may use (picker-enabled, not disabled by policy, able to call tools). */
export async function copilotModels(token: string, apiBase: string, signal?: AbortSignal): Promise<CopilotDiscoveredModel[]> {
  const { status, body } = await getJson(
    `${apiBase}/models`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": userAgent(),
        "X-GitHub-Api-Version": COPILOT_API_VERSION,
      },
    },
    signal,
  );
  if (status === 401) throw new CopilotAuthError("revoked", "GitHub Copilot no longer accepts this sign-in. Sign in again.");
  if (status !== 200) {
    const msg = typeof rec(body)?.message === "string" ? `: ${rec(body)!.message}` : "";
    throw new CopilotAuthError("failed", `GitHub Copilot /models returned HTTP ${status}${msg}`);
  }
  const parsed = parseCopilotModels(body);
  if (!parsed) throw new CopilotAuthError("failed", "GitHub Copilot /models returned an unexpected response");
  return parsed;
}

/** Model ids the account may use (picker-enabled, not disabled by policy, able to call tools). */
export async function copilotModelIds(token: string, apiBase: string, signal?: AbortSignal): Promise<string[]> {
  return (await copilotModels(token, apiBase, signal)).map((m) => m.id);
}

/** Checks the token and builds the credential to save. */
export async function connectCopilot(
  token: string,
  source: CopilotCredential["source"],
  signal?: AbortSignal,
  opts?: { strictModels?: boolean },
): Promise<CopilotCredential> {
  const account = await copilotAccount(token, signal);
  const discovered = await copilotModels(token, account.apiBase, signal).catch((e: unknown) => {
    if (opts?.strictModels || (e instanceof CopilotAuthError && e.code === "revoked")) throw e;
    return undefined;
  });
  const ids = discovered?.map((m) => m.id);
  return {
    type: "oauth",
    access: token,
    refresh: token,
    expires: Date.now() + RECHECK_MS,
    login: account.login,
    ...(account.plan ? { plan: account.plan } : {}),
    apiBase: account.apiBase,
    ...(ids?.length ? { availableModelIds: ids } : {}),
    ...(discovered?.length ? { availableModels: discovered } : {}),
    ...(discovered ? { modelsRefreshedAt: Date.now() } : {}),
    source,
  };
}

export function isCopilotCredential(c: unknown): c is CopilotCredential {
  const r = rec(c);
  return !!r && r.type === "oauth" && typeof r.access === "string" && typeof r.apiBase === "string" && typeof r.login === "string";
}

// ------------------------------------------------------------------ GitHub Copilot CLI

/** The Copilot CLI's config file: `$COPILOT_HOME/config.json`, else `~/.copilot/config.json`. */
export function copilotCliConfigPath(): string {
  return join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "config.json");
}

const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})$/;
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;

function readCopilotCliConfig(file: string): { tokens: Map<string, string>; loggedIn: string[] } {
  const tokens = new Map<string, string>();
  const loggedIn: string[] = [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { tokens, loggedIn };
  }
  let cfg: Record<string, unknown> | undefined;
  try {
    // The file starts with `//` comment lines.
    cfg = rec(JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")));
  } catch {
    return { tokens, loggedIn };
  }
  const rawTokens = rec(cfg?.authTokens);
  for (const [key, v] of Object.entries(rawTokens ?? {})) {
    const m = /^https:\/\/github\.com:([^:]+)$/.exec(key);
    const token = rec(v)?.token;
    if (m && GITHUB_LOGIN_RE.test(m[1]!) && typeof token === "string" && TOKEN_RE.test(token)) tokens.set(m[1]!, token);
  }
  const addUser = (u: unknown) => {
    const r = rec(u);
    if (!r || r.host !== GITHUB || typeof r.login !== "string") return;
    if (GITHUB_LOGIN_RE.test(r.login) && !loggedIn.includes(r.login)) loggedIn.push(r.login);
  };
  addUser(cfg?.lastLoggedInUser);
  if (Array.isArray(cfg?.loggedInUsers)) {
    for (const u of cfg.loggedInUsers) addUser(u);
  }
  return { tokens, loggedIn };
}

function resolveKeyring(file: string, keyring?: CopilotKeyring): CopilotKeyring | undefined {
  if (keyring) return keyring;
  return file === copilotCliConfigPath() ? osCopilotKeyring() : undefined;
}

/**
 * github.com accounts the Copilot CLI is signed in to on this machine (either plaintext tokens in
 * `config.json` or `loggedInUsers` backed by the OS keyring on Linux/macOS).
 */
export function copilotCliAccounts(file = copilotCliConfigPath(), keyring?: CopilotKeyring): string[] {
  const { tokens, loggedIn } = readCopilotCliConfig(file);
  const kr = resolveKeyring(file, keyring);
  const allowKeyring = !!kr?.available();
  const out: string[] = [];
  if (allowKeyring) {
    for (const login of loggedIn) {
      if (!out.includes(login)) out.push(login);
    }
  }
  for (const login of tokens.keys()) {
    if (!out.includes(login)) out.push(login);
  }
  return out;
}

export async function copilotCliToken(
  login: string,
  file = copilotCliConfigPath(),
  keyring?: CopilotKeyring,
  signal?: AbortSignal,
): Promise<string> {
  if (!GITHUB_LOGIN_RE.test(login)) throw new CopilotAuthError("failed", `Invalid GitHub login "${login}".`);
  const { tokens } = readCopilotCliConfig(file);
  const plain = tokens.get(login);
  if (plain) return plain;

  const kr = resolveKeyring(file, keyring);
  if (kr?.available()) {
    const res = await kr.read(login, signal);
    if (res.status === "ok" && TOKEN_RE.test(res.token)) return res.token;
    if (res.status === "locked") {
      throw new CopilotAuthError("failed", `Your system keyring is locked. Unlock it and try reusing the Copilot CLI sign-in for @${login} again.`);
    }
  }
  throw new CopilotAuthError("failed", `The GitHub Copilot CLI has no saved sign-in for @${login}.`);
}

// ------------------------------------------------------------------ pi-ai provider

/**
 * pi-ai OAuth for the saved credential. `refresh` re-checks the account (the token does not rotate); a network
 * failure keeps the credential working for a few more minutes instead of failing the conversation.
 */
export function copilotOAuth(clientId: () => string | undefined): OAuthAuth {
  return {
    name: "GitHub Copilot",
    isSubscription: true,
    loginLabel: "Sign in with GitHub",
    async login(interaction) {
      const id = clientId();
      if (!id) throw new CopilotAuthError("failed", "No GitHub OAuth app is configured (auth.githubClientId).");
      const device = await startDeviceFlow(id, interaction.signal);
      interaction.notify({
        type: "device_code",
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        intervalSeconds: device.intervalSeconds,
        expiresInSeconds: Math.round((device.expiresAt - Date.now()) / 1000),
      });
      return connectCopilot(await pollDeviceFlow(id, device, interaction.signal), "device", interaction.signal);
    },
    async refresh(credential, signal) {
      const current = credential as CopilotCredential;
      try {
        const next = await connectCopilot(current.access, current.source ?? "device", signal);
        return { ...next, source: current.source ?? next.source };
      } catch (e) {
        if (e instanceof CopilotAuthError && (e.code === "revoked" || e.code === "no_copilot")) throw e;
        return { ...current, expires: Date.now() + 5 * 60 * 1000 };
      }
    },
    async toAuth(credential) {
      const c = credential as CopilotCredential;
      return { apiKey: c.access, baseUrl: c.apiBase };
    },
  };
}

function synthesizeCopilotModel(d: CopilotDiscoveredModel, headers: Record<string, string>, baseUrl: string): Model<Api> {
  const base = {
    id: d.id,
    name: d.name || d.id,
    api: d.api,
    provider: COPILOT_PROVIDER,
    baseUrl,
    headers,
    reasoning: !!d.reasoning,
    input: (d.vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: d.contextWindow ?? 128_000,
    maxTokens: d.maxTokens ?? 16_384,
  };
  if (d.api === "openai-completions") {
    return { ...base, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: !!d.reasoning } } as Model<Api>;
  }
  return base as Model<Api>;
}

/**
 * pi-ai's Copilot catalog and API routing, with Spencer's sign-in, Spencer's own request headers, and
 * synthesized definitions for any live models returned by the account's `/models` endpoint that aren't in
 * pi-ai's static catalog (such as `gpt-4o` / `gpt-4o-mini` on Business accounts).
 */
export function spencerCopilotProvider(base: Provider, clientId: () => string | undefined, cred?: CopilotCredential): Provider {
  const headers = { "User-Agent": userAgent(), "X-GitHub-Api-Version": COPILOT_API_VERSION };
  const baseUrl = cred?.apiBase ?? "https://api.githubcopilot.com";
  const models: Model<Api>[] = base.getModels().map((m): Model<Api> => ({ ...m, headers }));
  const known = new Set(models.map((m) => m.id));
  const discovered: CopilotDiscoveredModel[] =
    cred?.availableModels?.length
      ? cred.availableModels
      : (cred?.availableModelIds ?? []).map((id) => ({
          id,
          name: id,
          api: inferCopilotApi(id, undefined),
          ...(inferReasoning(id, undefined) ? { reasoning: true } : {}),
        }));
  for (const d of discovered) {
    if (known.has(d.id)) continue;
    known.add(d.id);
    models.push(synthesizeCopilotModel(d, headers, baseUrl));
  }
  return createProvider({
    id: COPILOT_PROVIDER,
    name: "GitHub Copilot",
    baseUrl,
    headers,
    auth: { oauth: copilotOAuth(clientId) },
    models,
    filterModels: (list, credential) => {
      const ids = isCopilotCredential(credential) ? credential.availableModelIds : undefined;
      if (!ids?.length) return list;
      const allowed = new Set(ids);
      const filtered = list.filter((m) => allowed.has(m.id));
      return filtered.length ? filtered : list;
    },
    api: {
      stream: (model, context, options) => base.stream(model as never, context, options as never),
      streamSimple: (model, context, options) => base.streamSimple(model, context, options),
    },
  }) as Provider;
}

/** The model Spencer picks after sign-in. */
export function pickCopilotModel(available: readonly string[]): string | undefined {
  return PREFERRED_COPILOT_MODELS.find((id) => available.includes(id)) ?? available.find((id) => id.startsWith("claude-sonnet")) ?? available[0];
}
