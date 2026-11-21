/**
 * The model Spencer thinks with, chosen and signed in from the web UI's Model page:
 *
 *  - builds the pi-ai `Models` from config.json's `model` (models.ts), and rebuilds it live when the owner
 *    switches model or signs in, so no restart is needed;
 *  - runs "Sign in with GitHub" (Copilot device flow) and "use my GitHub CLI login", saving the result in
 *    `<dataDir>/secrets/credentials.json`;
 *  - reports all of it as `ModelStatus` (GET /api/model and `model` events).
 */
import type { Models } from "@earendil-works/pi-ai";
import type { ModelConfig } from "../config.ts";
import type { CoreServices, LoginState, ModelStatus } from "../contracts.ts";
import {
  COPILOT_PROVIDER,
  CopilotAuthError,
  connectCopilot,
  ghAccounts,
  ghToken,
  githubClientId,
  isCopilotCredential,
  pickCopilotModel,
  pollDeviceFlow,
  spencerCopilotProvider,
  startDeviceFlow,
  type CopilotCredential,
  type GhAccount,
} from "./copilot.ts";
import { FileCredentialStore } from "./credentials.ts";
import type { FakeBrainHooks } from "./fake-brain.ts";
import { loadBuiltinProvider, setupModels, type ModelSetup } from "./models.ts";

class ModelError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Copilot's Claude models refuse requests with thinking turned off (they want "between_tools"), so a Copilot
 * model always gets a thinking level; "medium" unless the owner set one.
 */
function copilotModelConfig(modelId: string, thinking: string | undefined): ModelConfig {
  return { provider: COPILOT_PROVIDER, modelId, thinking: thinking && thinking !== "off" ? thinking : "medium" } as ModelConfig;
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
  private catalog: { id: string; name: string }[] = [];
  private copilot: CopilotCredential | undefined;
  private signIn: (LoginState & { abort?: AbortController }) | undefined;
  private gh: GhAccount[] = [];
  private stopped = false;

  constructor(opts: ModelManagerOptions) {
    this.opts = opts;
    this.credentials = new FileCredentialStore(opts.core.dataDir);
  }

  private clientId(): string | undefined {
    return githubClientId(this.opts.core.config().auth?.githubClientId);
  }

  async init(): Promise<void> {
    const saved = await this.credentials.read(COPILOT_PROVIDER);
    this.copilot = isCopilotCredential(saved) ? saved : undefined;
    const base = await loadBuiltinProvider(COPILOT_PROVIDER).catch(() => undefined);
    if (base) this.catalog = spencerCopilotProvider(base, () => undefined).getModels().map((m) => ({ id: m.id, name: m.name }));
    await this.build();
    void this.refreshGh();
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

  private copilotModels(): { id: string; name: string }[] {
    const ids = this.copilot?.availableModelIds;
    if (!ids?.length) return this.catalog;
    const allowed = new Set(ids);
    return this.catalog.filter((m) => allowed.has(m.id));
  }

  status(): ModelStatus {
    const m = this.opts.core.config().model as { provider: string; modelId?: string };
    const c = this.copilot;
    const signIn = this.signIn ? (({ abort: _a, ...rest }) => rest)(this.signIn) : undefined;
    return {
      provider: m.provider,
      ...(m.modelId ? { modelId: m.modelId } : {}),
      ready: !!this.setup?.ref,
      ...(this.setup?.error ? { error: this.setup.error } : {}),
      copilot: {
        connected: !!c,
        ...(c ? { login: c.login, via: c.source, ...(c.plan ? { plan: c.plan } : {}) } : {}),
        models: c ? this.copilotModels() : [],
        deviceLogin: !!this.clientId(),
        ghAccounts: this.gh,
        ...(signIn ? { signIn } : {}),
      },
    };
  }

  /** Re-reads the GitHub CLI accounts (it is cheap; called when the Model page opens). */
  async refreshGh(): Promise<void> {
    const next = await ghAccounts();
    if (JSON.stringify(next) !== JSON.stringify(this.gh)) {
      this.gh = next;
      this.emit();
    }
  }

  async setModel(provider: string, modelId: string): Promise<ModelStatus> {
    if (typeof provider !== "string" || typeof modelId !== "string" || !modelId) throw new ModelError(400, "provider and modelId are required");
    const current = this.opts.core.config().model as ModelConfig & { modelId?: string; thinking?: string };
    let next: ModelConfig;
    if (provider === COPILOT_PROVIDER) {
      if (!this.copilot) throw new ModelError(409, "Sign in to GitHub Copilot first.");
      if (!this.copilotModels().some((m) => m.id === modelId)) throw new ModelError(400, `GitHub Copilot has no model "${modelId}" for @${this.copilot.login}`);
      next = copilotModelConfig(modelId, current.provider === COPILOT_PROVIDER ? current.thinking : undefined);
    } else if (provider === current.provider && provider !== "fake") {
      next = { ...current, modelId } as ModelConfig;
    } else {
      throw new ModelError(400, "Only GitHub Copilot models can be picked here; other providers are set in config.json.");
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
      throw new ModelError(409, "Sign in with GitHub needs Spencer's GitHub OAuth app id (auth.githubClientId in config.json). Use a GitHub CLI login instead.");
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

  async useGhLogin(login: string): Promise<ModelStatus> {
    if (typeof login !== "string" || !login) throw new ModelError(400, "login is required");
    let cred: CopilotCredential;
    try {
      cred = await connectCopilot(await ghToken(login), "gh-cli");
    } catch (e) {
      const status = e instanceof CopilotAuthError && e.code === "network" ? 502 : 400;
      throw new ModelError(status, (e as Error).message);
    }
    this.signIn?.abort?.abort(new Error("replaced"));
    await this.connected(cred);
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
