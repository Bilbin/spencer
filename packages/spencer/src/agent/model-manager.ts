/**
 * The model Spencer thinks with, chosen and signed in from the web UI's Model page:
 *
 *  - builds the pi-ai `Models` from config.json's `model` (models.ts), and rebuilds it live when the owner
 *    switches model or signs in, so no restart is needed;
 *  - runs "Sign in with GitHub" (Copilot device flow), saving the result in
 *    `<dataDir>/secrets/credentials.json`;
 *  - reports all of it as `ModelStatus` (GET /api/model and `model` events).
 */
import type { Models } from "@earendil-works/pi-ai";
import type { ModelConfig, ThinkingLevel } from "../config.ts";
import type { CoreServices, LoginState, ModelProviderOption, ModelStatus, SetModelOptions } from "../contracts.ts";
import {
  COPILOT_PROVIDER,
  CopilotAuthError,
  PREFERRED_COPILOT_MODELS,
  connectCopilot,
  githubClientId,
  isCopilotCredential,
  pickCopilotModel,
  pollDeviceFlow,
  spencerCopilotProvider,
  startDeviceFlow,
  type CopilotCredential,
} from "./copilot.ts";
import { FileCredentialStore } from "./credentials.ts";
import type { FakeBrainHooks } from "./fake-brain.ts";
import { defaultApiKeyEnvFor, loadBuiltinProvider, PICKER_PROVIDERS, setupModels, type ModelSetup } from "./models.ts";
import { BUILTIN_PROVIDERS } from "./providers.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high"]);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

class ModelError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Copilot's Claude models refuse requests with thinking turned off (they want "between_tools"), so a Copilot
 * Claude model gets "medium" unless the owner picked another level. Other Copilot models (like GPT-4o) respect
 * "off".
 */
function copilotModelConfig(modelId: string, thinking: string | undefined): ModelConfig {
  const needsThinking = /^claude-/i.test(modelId);
  const level = thinking && thinking !== "off" ? thinking : needsThinking ? "medium" : undefined;
  return { provider: COPILOT_PROVIDER, modelId, ...(level ? { thinking: level } : {}) } as ModelConfig;
}

function normalizeHttpUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ModelError(400, "baseUrl must be a valid http(s) URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ModelError(400, "baseUrl must use http:// or https://");
  return u.toString().replace(/\/+$/, "");
}

export interface ModelManagerOptions {
  core: CoreServices;
  name: () => string;
  fakeHooks?: FakeBrainHooks;
  log: (m: string) => void;
  /** The model changed: reconfigure every conversation. */
  onReload: () => Promise<void>;
}

export class ModelManager {
  private opts: ModelManagerOptions;
  readonly credentials: FileCredentialStore;
  private setup: ModelSetup | undefined;
  private catalog: { id: string; name: string; reasoning?: boolean }[] = [];
  private catalogs = new Map<string, { name: string; models: { id: string; name: string; reasoning?: boolean }[] }>();
  private savedKeys = new Set<string>();
  private copilot: CopilotCredential | undefined;
  private signIn: (LoginState & { abort?: AbortController }) | undefined;
  private stopped = false;

  constructor(opts: ModelManagerOptions) {
    this.opts = opts;
    this.credentials = new FileCredentialStore(opts.core.dataDir);
  }

  private clientId(): string | undefined {
    return githubClientId(this.opts.core.config().auth?.githubClientId);
  }

  private async ensureCatalog(providerId: string): Promise<{ name: string; models: { id: string; name: string; reasoning?: boolean }[] } | undefined> {
    const existing = this.catalogs.get(providerId);
    if (existing) return existing;
    const p = await loadBuiltinProvider(providerId).catch(() => undefined);
    if (!p) return undefined;
    const entry = {
      name: p.name || providerId,
      models: p.getModels().map((m) => ({ id: m.id, name: m.name, ...(m.reasoning ? { reasoning: true } : {}) })),
    };
    this.catalogs.set(providerId, entry);
    return entry;
  }

  async init(): Promise<void> {
    const saved = await this.credentials.read(COPILOT_PROVIDER);
    this.copilot = isCopilotCredential(saved) ? saved : undefined;
    const credList = await this.credentials.list();
    this.savedKeys = new Set(credList.filter((c) => c.type === "api_key").map((c) => c.providerId));
    const base = await loadBuiltinProvider(COPILOT_PROVIDER).catch(() => undefined);
    if (base) {
      this.catalog = spencerCopilotProvider(base, () => undefined)
        .getModels()
        .map((m) => ({ id: m.id, name: m.name, ...(m.reasoning ? { reasoning: true } : {}) }));
    }
    const toLoad = new Set(PICKER_PROVIDERS.filter((p) => !p.custom && p.id !== COPILOT_PROVIDER).map((p) => p.id));
    const curProv = this.opts.core.config().model.provider;
    if (curProv && curProv !== "fake" && curProv !== "openai-compatible" && curProv !== COPILOT_PROVIDER && Object.hasOwn(BUILTIN_PROVIDERS, curProv)) {
      toLoad.add(curProv);
    }
    await Promise.all([...toLoad].map((id) => this.ensureCatalog(id)));
    await this.build();
  }

  stop(): void {
    this.stopped = true;
    this.signIn?.abort?.abort(new Error("stopping"));
  }

  models(): Models | undefined {
    return this.setup?.models;
  }
  ref(): { provider: string; modelId: string } | undefined {
    return this.setup?.ref;
  }
  error(): string | undefined {
    return this.setup?.error;
  }

  private async build(): Promise<void> {
    this.setup = await setupModels(this.opts.core.config().model, {
      name: this.opts.name,
      ...(this.opts.fakeHooks ? { fakeHooks: this.opts.fakeHooks } : {}),
      credentials: this.credentials,
      githubClientId: () => this.clientId(),
    });
    if (this.setup.error) this.opts.log(`model not available: ${this.setup.error}`);
  }

  private async reload(): Promise<void> {
    await this.build();
    await this.opts.onReload();
    this.emit();
  }

  private emit(): void {
    if (this.stopped) return;
    this.opts.core.events.emit({ type: "model", model: this.status() });
  }

  private copilotModels(): { id: string; name: string; reasoning?: boolean }[] {
    const byId = new Map(this.catalog.map((m) => [m.id, m]));
    const rank = (id: string) => {
      const i = PREFERRED_COPILOT_MODELS.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const sortPref = (list: { id: string; name: string; reasoning?: boolean }[]) =>
      [...list].sort((a, b) => rank(a.id) - rank(b.id));

    const discovered = this.copilot?.availableModels;
    if (discovered?.length) {
      return sortPref(
        discovered.map((d) => byId.get(d.id) ?? { id: d.id, name: d.name || d.id, ...(d.reasoning ? { reasoning: true } : {}) }),
      );
    }
    const ids = this.copilot?.availableModelIds;
    if (ids?.length) {
      return sortPref(ids.map((id) => byId.get(id) ?? { id, name: id }));
    }
    return this.catalog;
  }

  private providerOptions(cur: { provider: string; apiKeyEnv?: string }): ModelProviderOption[] {
    const list: ModelProviderOption[] = PICKER_PROVIDERS.map((p) => {
      if (p.id === COPILOT_PROVIDER) {
        return { id: p.id, name: p.name, models: this.copilot ? this.copilotModels() : [] };
      }
      if (p.custom) {
        const envName = cur.provider === p.id ? cur.apiKeyEnv : undefined;
        return {
          id: p.id,
          name: p.name,
          custom: true,
          ...(envName ? { hasEnvKey: Boolean(process.env[envName]) } : {}),
          hasSavedKey: this.savedKeys.has(p.id),
          models: [],
        };
      }
      const envName = cur.provider === p.id && cur.apiKeyEnv ? cur.apiKeyEnv : p.defaultApiKeyEnv;
      return {
        id: p.id,
        name: p.name,
        ...(p.defaultApiKeyEnv ? { defaultApiKeyEnv: p.defaultApiKeyEnv } : {}),
        hasEnvKey: envName ? Boolean(process.env[envName]) : false,
        hasSavedKey: this.savedKeys.has(p.id),
        models: this.catalogs.get(p.id)?.models ?? [],
      };
    });
    if (cur.provider && cur.provider !== "fake" && !list.some((p) => p.id === cur.provider)) {
      const cat = this.catalogs.get(cur.provider);
      list.push({
        id: cur.provider,
        name: cat?.name ?? cur.provider,
        ...(cur.apiKeyEnv ? { defaultApiKeyEnv: cur.apiKeyEnv, hasEnvKey: Boolean(process.env[cur.apiKeyEnv]) } : {}),
        hasSavedKey: this.savedKeys.has(cur.provider),
        models: cat?.models ?? [],
      });
    }
    return list;
  }

  status(): ModelStatus {
    const m = this.opts.core.config().model as {
      provider: string;
      modelId?: string;
      thinking?: ThinkingLevel;
      baseUrl?: string;
      apiKeyEnv?: string;
    };
    const c = this.copilot;
    const signIn = this.signIn ? (({ abort: _a, ...rest }) => rest)(this.signIn) : undefined;
    return {
      provider: m.provider,
      ...(m.modelId ? { modelId: m.modelId } : {}),
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
      ...(m.apiKeyEnv ? { apiKeyEnv: m.apiKeyEnv } : {}),
      ready: !!this.setup?.ref,
      ...(this.setup?.error ? { error: this.setup.error } : {}),
      providers: this.providerOptions(m),
      copilot: {
        connected: !!c,
        ...(c ? { login: c.login, via: c.source, ...(c.plan ? { plan: c.plan } : {}) } : {}),
        models: c ? this.copilotModels().map(({ id, name }) => ({ id, name })) : [],
        deviceLogin: !!this.clientId(),
        ...(signIn ? { signIn } : {}),
      },
    };
  }

  async setModel(provider: string, modelId: string, opts: SetModelOptions = {}): Promise<ModelStatus> {
    if (typeof provider !== "string" || typeof modelId !== "string" || !provider.trim() || !modelId.trim()) {
      throw new ModelError(400, "provider and modelId are required");
    }
    const prov = provider.trim();
    const mid = modelId.trim();
    if (opts.thinking !== undefined && !THINKING_LEVELS.has(opts.thinking)) {
      throw new ModelError(400, `thinking must be one of ${[...THINKING_LEVELS].join(", ")}`);
    }
    let apiKeyEnv: string | undefined;
    if (opts.apiKeyEnv !== undefined && opts.apiKeyEnv.trim() !== "") {
      apiKeyEnv = opts.apiKeyEnv.trim();
      if (!ENV_NAME_RE.test(apiKeyEnv)) throw new ModelError(400, "apiKeyEnv must be an environment variable name");
    }
    const baseUrl = opts.baseUrl !== undefined && opts.baseUrl.trim() !== "" ? normalizeHttpUrl(opts.baseUrl) : undefined;
    const current = this.opts.core.config().model as ModelConfig & {
      modelId?: string;
      thinking?: ThinkingLevel;
      baseUrl?: string;
      apiKeyEnv?: string;
    };

    const updateKey = async (target: string) => {
      if (opts.clearApiKey) {
        await this.credentials.delete(target);
        this.savedKeys.delete(target);
      } else if (typeof opts.apiKey === "string" && opts.apiKey.trim()) {
        await this.credentials.modify(target, async () => ({ type: "api_key", key: opts.apiKey!.trim() }));
        this.savedKeys.add(target);
      }
    };

    let next: ModelConfig;
    if (prov === COPILOT_PROVIDER) {
      if (!this.copilot) throw new ModelError(409, "Sign in to GitHub Copilot first.");
      if (!this.copilotModels().some((m) => m.id === mid)) throw new ModelError(400, `GitHub Copilot has no model "${mid}" for @${this.copilot.login}`);
      const thinking = opts.thinking ?? (current.provider === COPILOT_PROVIDER ? current.thinking : undefined);
      next = copilotModelConfig(mid, thinking);
    } else if (prov === "openai-compatible") {
      const url = baseUrl ?? (current.provider === "openai-compatible" ? current.baseUrl : undefined);
      if (!url) throw new ModelError(400, 'baseUrl is required for "openai-compatible"');
      await updateKey(prov);
      const env = apiKeyEnv ?? (current.provider === "openai-compatible" ? current.apiKeyEnv : undefined);
      const thinking = opts.thinking ?? (current.provider === "openai-compatible" ? current.thinking : undefined);
      next = {
        provider: "openai-compatible",
        baseUrl: url,
        modelId: mid,
        ...(env ? { apiKeyEnv: env } : {}),
        ...(thinking && thinking !== "off" ? { thinking } : {}),
      };
    } else if (Object.hasOwn(BUILTIN_PROVIDERS, prov)) {
      const cat = await this.ensureCatalog(prov);
      if (!cat) throw new ModelError(400, `unknown model provider "${prov}"`);
      if (!cat.models.some((m) => m.id === mid)) throw new ModelError(400, `provider "${prov}" has no model "${mid}"`);
      await updateKey(prov);
      const defEnv = defaultApiKeyEnvFor(prov);
      const env = apiKeyEnv ?? (current.provider === prov ? current.apiKeyEnv : undefined) ?? (this.savedKeys.has(prov) ? undefined : defEnv);
      const url = baseUrl ?? (current.provider === prov && opts.baseUrl === undefined ? current.baseUrl : undefined);
      const thinking = opts.thinking ?? (current.provider === prov ? current.thinking : undefined);
      next = {
        provider: prov,
        modelId: mid,
        ...(env ? { apiKeyEnv: env } : {}),
        ...(url ? { baseUrl: url } : {}),
        ...(thinking && thinking !== "off" ? { thinking } : {}),
      };
    } else {
      throw new ModelError(400, `unknown model provider "${prov}"`);
    }
    this.save(next);
    await this.reload();
    return this.status();
  }

  private save(model: ModelConfig): void {
    if (!this.opts.core.saveModel) throw new ModelError(501, "this Spencer cannot change its model at runtime");
    this.opts.core.saveModel(model);
  }

  /** A Copilot sign-in succeeded: save it, and if Spencer has no working model yet, start using Copilot. */
  private async connected(cred: CopilotCredential): Promise<void> {
    await this.credentials.modify(COPILOT_PROVIDER, async () => cred);
    this.copilot = cred;
    this.signIn = undefined;
    this.opts.log(`GitHub Copilot connected as @${cred.login}${cred.plan ? ` (${cred.plan})` : ""}`);
    const current = this.opts.core.config().model as { provider: string; modelId?: string };
    const available = this.copilotModels().map((m) => m.id);
    const keep = current.provider === COPILOT_PROVIDER && current.modelId && available.includes(current.modelId);
    if (!keep && (current.provider === COPILOT_PROVIDER || !this.setup?.ref)) {
      const pick = pickCopilotModel(available);
      if (pick) this.save(copilotModelConfig(pick, current.provider === COPILOT_PROVIDER ? (current as { thinking?: string }).thinking : undefined));
    }
    await this.reload();
  }

  async startCopilotLogin(): Promise<ModelStatus> {
    const clientId = this.clientId();
    if (!clientId) {
      throw new ModelError(409, "Sign in with GitHub needs a GitHub OAuth app id (auth.githubClientId in config.json).");
    }
    this.signIn?.abort?.abort(new Error("restarted"));
    const abort = new AbortController();
    let device;
    try {
      device = await startDeviceFlow(clientId, abort.signal);
    } catch (e) {
      throw new ModelError(502, (e as Error).message);
    }
    const state: LoginState & { abort?: AbortController } = {
      state: "waiting",
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      expiresAt: device.expiresAt,
      abort,
    };
    this.signIn = state;
    this.emit();
    void (async () => {
      try {
        const token = await pollDeviceFlow(clientId, device, abort.signal);
        if (this.signIn !== state) return;
        state.state = "connecting";
        this.emit();
        const cred = await connectCopilot(token, "device", abort.signal);
        if (this.signIn !== state) return;
        await this.connected(cred);
      } catch (e) {
        if (this.signIn !== state || abort.signal.aborted) return;
        this.signIn = { state: "failed", error: e instanceof CopilotAuthError ? e.message : `Sign-in failed: ${(e as Error).message}` };
        this.emit();
      }
    })();
    return this.status();
  }

  cancelCopilotLogin(): ModelStatus {
    if (this.signIn?.state === "waiting" || this.signIn?.state === "connecting") {
      this.signIn.abort?.abort(new Error("cancelled"));
      this.signIn = { state: "cancelled" };
    } else {
      this.signIn = undefined;
    }
    this.emit();
    return this.status();
  }

  async copilotLogout(): Promise<ModelStatus> {
    this.signIn?.abort?.abort(new Error("signed out"));
    this.signIn = undefined;
    await this.credentials.delete(COPILOT_PROVIDER);
    this.copilot = undefined;
    this.opts.log("GitHub Copilot signed out");
    await this.reload();
    return this.status();
  }
}
