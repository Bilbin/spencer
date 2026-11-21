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
 * Instead of the device flow, a person who already uses the GitHub CLI can reuse its login (`gh auth token`).
 *
 * The provider id stays `github-copilot` so pi-ai's per-API Copilot handling (Bearer auth, X-Initiator, vision
 * header) applies; models route per their `api` (Anthropic Messages for Claude, Responses for GPT, …).
 */
import { execFile } from "node:child_process";
import { createProvider, type Api, type Model, type OAuthAuth, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";

export const COPILOT_PROVIDER = "github-copilot";

/**
 * Spencer's GitHub OAuth app (Device Flow enabled). Empty until one is registered; `auth.githubClientId` in
 * config.json or SPENCER_GITHUB_CLIENT_ID sets it. Without one, only the GitHub CLI sign-in is offered.
 */
export const DEFAULT_GITHUB_CLIENT_ID = "";

const GITHUB = "https://github.com";
const GITHUB_API = "https://api.github.com";
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Re-check the account (plan, endpoint, models) this often; the token itself does not expire. */
const RECHECK_MS = 6 * 60 * 60 * 1000;
/** Used first, in order, when Spencer picks a model after sign-in. */
export const PREFERRED_COPILOT_MODELS = ["claude-sonnet-5.5", "claude-sonnet-5", "gpt-6.1-terra", "claude-opus-5.5"];

export function userAgent(): string {
  return `spencer/${process.env.SPENCER_BUILD ?? "dev"}`;
}

export function githubClientId(configured?: string): string | undefined {
  const id = (process.env.SPENCER_GITHUB_CLIENT_ID || configured || DEFAULT_GITHUB_CLIENT_ID).trim();
  return id && CLIENT_ID_RE.test(id) ? id : undefined;
}

/** The saved credential: an OAuth credential whose access and refresh are both the GitHub token. */
export interface CopilotCredential extends OAuthCredential {
  login: string;
  plan?: string;
  apiBase: string;
  availableModelIds?: string[];
  source: "device" | "gh-cli";
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

/** Polls until the person approves (resolves with the GitHub token), denies, or the code expires. */
export async function pollDeviceFlow(clientId: string, device: DeviceCode, signal: AbortSignal): Promise<string> {
  let interval = device.intervalSeconds;
  for (;;) {
    await sleep(interval * 1000, signal);
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
    { headers: { Accept: "application/json", Authorization: `token ${token}`, "User-Agent": userAgent() } },
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

/** Model ids the account may use (picker-enabled, not disabled by policy, able to call tools). */
export async function copilotModelIds(token: string, apiBase: string, signal?: AbortSignal): Promise<string[] | undefined> {
  const { status, body } = await getJson(
    `${apiBase}/models`,
    { headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": userAgent() } },
    signal,
  );
  if (status === 401) throw new CopilotAuthError("revoked", "GitHub Copilot no longer accepts this sign-in. Sign in again.");
  const data = rec(body)?.data;
  if (status !== 200 || !Array.isArray(data)) return undefined;
  const rows = data.flatMap((raw) => {
    const m = rec(raw);
    if (!m || typeof m.id !== "string") return [];
    if (rec(rec(m.capabilities)?.supports)?.tool_calls === false) return [];
    return [{ id: m.id, picker: m.model_picker_enabled === true, policy: rec(m.policy)?.state }];
  });
  const picker = rows.filter((r) => r.picker && r.policy !== "disabled").map((r) => r.id);
  const ids = picker.length ? picker : rows.filter((r) => r.policy !== "disabled").map((r) => r.id);
  return [...new Set(ids)];
}

/** Checks the token and builds the credential to save. */
export async function connectCopilot(token: string, source: CopilotCredential["source"], signal?: AbortSignal): Promise<CopilotCredential> {
  const account = await copilotAccount(token, signal);
  const ids = await copilotModelIds(token, account.apiBase, signal).catch((e: unknown) => {
    if (e instanceof CopilotAuthError && e.code === "revoked") throw e;
    return undefined;
  });
  return {
    type: "oauth",
    access: token,
    refresh: token,
    expires: Date.now() + RECHECK_MS,
    login: account.login,
    ...(account.plan ? { plan: account.plan } : {}),
    apiBase: account.apiBase,
    ...(ids ? { availableModelIds: ids } : {}),
    source,
  };
}

export function isCopilotCredential(c: unknown): c is CopilotCredential {
  const r = rec(c);
  return !!r && r.type === "oauth" && typeof r.access === "string" && typeof r.apiBase === "string" && typeof r.login === "string";
}

// ------------------------------------------------------------------ GitHub CLI

export interface GhAccount {
  login: string;
  active: boolean;
}

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

/** github.com accounts the GitHub CLI is signed in to; [] when gh is missing or signed out. */
export async function ghAccounts(): Promise<GhAccount[]> {
  try {
    const out = JSON.parse(await gh(["auth", "status", "--hostname", "github.com", "--json", "hosts"])) as unknown;
    const list = rec(rec(out)?.hosts)?.["github.com"];
    if (!Array.isArray(list)) return [];
    return list.flatMap((a) => {
      const r = rec(a);
      return r && typeof r.login === "string" && r.state === "success" ? [{ login: r.login, active: r.active === true }] : [];
    });
  } catch {
    return [];
  }
}

export async function ghToken(login: string): Promise<string> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})$/.test(login)) throw new CopilotAuthError("failed", "not a GitHub username");
  let out: string;
  try {
    out = await gh(["auth", "token", "--hostname", "github.com", "--user", login]);
  } catch {
    throw new CopilotAuthError("failed", `The GitHub CLI has no login for @${login}.`);
  }
  const token = out.trim();
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new CopilotAuthError("failed", "The GitHub CLI returned an unexpected token.");
  return token;
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

/** pi-ai's Copilot catalog and API routing, with Spencer's sign-in and Spencer's own request headers. */
export function spencerCopilotProvider(base: Provider, clientId: () => string | undefined): Provider {
  const headers = { "User-Agent": userAgent() };
  const models = base.getModels().map((m): Model<Api> => ({ ...m, headers }));
  return createProvider({
    id: COPILOT_PROVIDER,
    name: "GitHub Copilot",
    baseUrl: "https://api.githubcopilot.com",
    headers,
    auth: { oauth: copilotOAuth(clientId) },
    models,
    filterModels: (list, credential) => {
      const ids = isCopilotCredential(credential) ? credential.availableModelIds : undefined;
      if (!ids?.length) return list;
      const allowed = new Set(ids);
      return list.filter((m) => allowed.has(m.id));
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
