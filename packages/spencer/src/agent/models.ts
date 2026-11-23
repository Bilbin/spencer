/**
 * `ModelConfig` → pi-ai `Models` + the model ref conversations run with.
 *
 *  - built-in provider ids: dynamic import of `@earendil-works/pi-ai/providers/<id>` (id checked against an
 *    allowlist pattern), using the module's `<camelCaseId>Provider` factory;
 *  - `openai-compatible`: `createProvider` + `openAICompletionsApi()` with `baseUrl`;
 *  - `fake`: a faux provider driven by `fake-brain.ts`.
 *
 * API keys (from `apiKeyEnv` or a literal `apiKey`) go into an in-memory credential store for that provider
 * and are never logged. `github-copilot` is Spencer's own Copilot sign-in (copilot.ts); its credential lives in
 * the saved store passed as `credentials`. A misconfiguration does not throw: the result carries `error` and no `ref`, so
 * conversations run without a model and the agent turns that into a clear error in the owner chat.
 */
import {
  createFauxCore,
  createModels,
  createProvider,
  InMemoryCredentialStore,
  type Model,
  type Models,
  type MutableModels,
  type CredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ModelConfig } from "../config.ts";
import { COPILOT_PROVIDER, isCopilotCredential, spencerCopilotProvider } from "./copilot.ts";
import { createFakeBrain, type FakeBrainHooks } from "./fake-brain.ts";
import { BUILTIN_PROVIDERS } from "./providers.ts";

export interface ModelSetup {
  models: Models;
  /** Absent when misconfigured. */
  ref?: { provider: string; modelId: string };
  /** Human-readable configuration error (never contains a key). */
  error?: string;
}

export const FAKE_PROVIDER = "spencer-fake";
export const FAKE_MODEL = "fake";
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Curated providers shown in the UI model picker, in display order, with default API-key env vars. */
export const PICKER_PROVIDERS: readonly { id: string; name: string; defaultApiKeyEnv?: string; custom?: boolean }[] = [
  { id: COPILOT_PROVIDER, name: "GitHub Copilot" },
  { id: "anthropic", name: "Anthropic", defaultApiKeyEnv: "ANTHROPIC_API_KEY" },
  { id: "openai", name: "OpenAI", defaultApiKeyEnv: "OPENAI_API_KEY" },
  { id: "google", name: "Google Gemini", defaultApiKeyEnv: "GEMINI_API_KEY" },
  { id: "openrouter", name: "OpenRouter", defaultApiKeyEnv: "OPENROUTER_API_KEY" },
  { id: "xai", name: "xAI", defaultApiKeyEnv: "XAI_API_KEY" },
  { id: "groq", name: "Groq", defaultApiKeyEnv: "GROQ_API_KEY" },
  { id: "deepseek", name: "DeepSeek", defaultApiKeyEnv: "DEEPSEEK_API_KEY" },
  { id: "openai-compatible", name: "OpenAI-compatible (Ollama / vLLM / local)", custom: true },
];

export function defaultApiKeyEnvFor(providerId: string): string | undefined {
  return PICKER_PROVIDERS.find((p) => p.id === providerId)?.defaultApiKeyEnv;
}

export async function setupModels(
  cfg: ModelConfig,
  opts: {
    name: () => string;
    fakeHooks?: FakeBrainHooks;
    /** Saved sign-ins (OAuth credentials and UI-saved API keys). */
    credentials?: CredentialStore;
    /** Spencer's GitHub OAuth app id, if any. */
    githubClientId?: () => string | undefined;
  },
): Promise<ModelSetup> {
  try {
    if (cfg.provider === "fake") return fakeSetup(opts);
    if (cfg.provider === COPILOT_PROVIDER) return await copilotSetup(cfg as { modelId?: string }, opts);
    const c = cfg as { provider: string; modelId?: string; apiKeyEnv?: string; apiKey?: string; baseUrl?: string };
    if (!c.modelId || typeof c.modelId !== "string") return fail(`model.modelId is required for provider "${c.provider}"`);
    const key = await resolveKey(c, opts.credentials);
    if (key.error) return fail(key.error);
    const credentials = new InMemoryCredentialStore();
    const models = createModels({ credentials });
    let provider: Provider;
    if (c.provider === "openai-compatible") {
      if (!c.baseUrl) return fail('model.baseUrl is required for provider "openai-compatible"');
      provider = await openAICompatibleProvider(cfg as Extract<ModelConfig, { provider: "openai-compatible" }>, key.value);
    } else {
      if (!PROVIDER_ID.test(c.provider)) return fail(`invalid model.provider "${c.provider}"`);
      const loaded = await loadBuiltinProvider(c.provider);
      if (!loaded) return fail(`unknown model provider "${c.provider}"`);
      provider = c.baseUrl ? withBaseUrl(loaded, c.baseUrl) : loaded;
      if (key.value) await credentials.modify(provider.id, async () => ({ type: "api_key", key: key.value }));
    }
    models.setProvider(provider);
    const providerId = provider.id;
    if (!models.getModel(providerId, c.modelId)) return { models, error: `unknown model "${c.modelId}" for provider "${providerId}"` };
    return { models, ref: { provider: providerId, modelId: c.modelId } };
  } catch (e) {
    return fail(`model setup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function copilotSetup(
  c: { modelId?: string },
  opts: { credentials?: CredentialStore; githubClientId?: () => string | undefined },
): Promise<ModelSetup> {
  const base = await loadBuiltinProvider(COPILOT_PROVIDER);
  if (!base) return fail("the GitHub Copilot provider is missing from this build");
  const credentials = opts.credentials ?? new InMemoryCredentialStore();
  const models = createModels({ credentials });
  const provider = spencerCopilotProvider(base, opts.githubClientId ?? (() => undefined));
  models.setProvider(provider);
  if (!isCopilotCredential(await credentials.read(COPILOT_PROVIDER))) {
    return { models, error: "GitHub Copilot is not connected yet: sign in on the Model page" };
  }
  if (!c.modelId || typeof c.modelId !== "string") return { models, error: "no GitHub Copilot model is chosen: pick one on the Model page" };
  if (!models.getModel(COPILOT_PROVIDER, c.modelId)) return { models, error: `unknown GitHub Copilot model "${c.modelId}"` };
  return { models, ref: { provider: COPILOT_PROVIDER, modelId: c.modelId } };
}

function fail(error: string): ModelSetup {
  return { models: createModels(), error };
}

async function resolveKey(
  c: { provider: string; apiKeyEnv?: string; apiKey?: string },
  credentials?: CredentialStore,
): Promise<{ value?: string; error?: string }> {
  if (c.apiKey) return { value: c.apiKey };
  if (credentials) {
    const saved = await credentials.read(c.provider);
    if (saved && saved.type === "api_key" && typeof saved.key === "string" && saved.key) return { value: saved.key };
  }
  if (c.apiKeyEnv) {
    const v = process.env[c.apiKeyEnv];
    if (v) return { value: v };
    return { error: `environment variable ${c.apiKeyEnv} (model.apiKeyEnv) is not set` };
  }
  const defEnv = defaultApiKeyEnvFor(c.provider);
  if (defEnv) {
    const v = process.env[defEnv];
    if (v) return { value: v };
    return { error: `environment variable ${defEnv} is not set (set it or save an API key on the Model page)` };
  }
  return {};
}

function fakeSetup(opts: { name: () => string; fakeHooks?: FakeBrainHooks }): ModelSetup {
  const core = createFauxCore({ provider: FAKE_PROVIDER, models: [{ id: FAKE_MODEL, name: "Fake (deterministic)" }] });
  const brain = createFakeBrain({ name: opts.name, hooks: opts.fakeHooks });
  // The faux core answers from a queue; keep exactly one brain step queued per request, appended synchronously
  // right before the request takes it, so concurrent conversations never find the queue empty.
  const provider = createProvider({
    id: FAKE_PROVIDER,
    name: "Fake",
    auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
    models: core.models,
    api: {
      stream: (model, context, options) => {
        core.appendResponses([brain]);
        return core.stream(model, context, options);
      },
      streamSimple: (model, context, options) => {
        core.appendResponses([brain]);
        return core.streamSimple(model, context, options);
      },
    },
  });
  const models: MutableModels = createModels();
  models.setProvider(provider);
  return { models, ref: { provider: FAKE_PROVIDER, modelId: FAKE_MODEL } };
}

async function openAICompatibleProvider(
  cfg: Extract<ModelConfig, { provider: "openai-compatible" }>,
  key: string | undefined,
): Promise<Provider> {
  const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
  const model: Model<"openai-completions"> = {
    id: cfg.modelId,
    name: cfg.modelId,
    api: "openai-completions",
    provider: "openai-compatible",
    baseUrl: cfg.baseUrl,
    reasoning: !!cfg.thinking && cfg.thinking !== "off",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow ?? 128_000,
    maxTokens: cfg.maxTokens ?? 8192,
    // Common for Ollama, vLLM, llama.cpp and similar servers.
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: !!cfg.thinking && cfg.thinking !== "off" },
  };
  return createProvider({
    id: "openai-compatible",
    name: "OpenAI-compatible",
    baseUrl: cfg.baseUrl,
    auth: { apiKey: { name: "OpenAI-compatible API key", resolve: async () => ({ auth: key ? { apiKey: key } : {} }) } },
    models: [model],
    api: openAICompletionsApi(),
  }) as Provider;
}

/** `amazon-bedrock` → `amazonBedrockProvider`, from `@earendil-works/pi-ai/providers/amazon-bedrock`. */
export async function loadBuiltinProvider(id: string): Promise<Provider | undefined> {
  const load = Object.hasOwn(BUILTIN_PROVIDERS, id) ? BUILTIN_PROVIDERS[id] : undefined;
  if (!load) return undefined;
  let mod: Record<string, unknown>;
  try {
    mod = await load();
  } catch {
    return undefined;
  }
  const expected = id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()) + "Provider";
  const factory = mod[expected] ?? Object.entries(mod).find(([k, v]) => /Provider$/.test(k) && typeof v === "function")?.[1];
  if (typeof factory !== "function") return undefined;
  const provider = (factory as () => Provider)();
  return provider && typeof provider === "object" && typeof provider.streamSimple === "function" ? provider : undefined;
}

/** The same provider with every model pointed at `baseUrl` (e.g. a gateway). */
function withBaseUrl(p: Provider, baseUrl: string): Provider {
  return createProvider({
    id: p.id,
    name: p.name,
    baseUrl,
    headers: p.headers,
    auth: p.auth,
    models: p.getModels().map((m) => ({ ...m, baseUrl })),
    api: {
      stream: (model, context, options) => p.stream(model as never, context, options as never),
      streamSimple: (model, context, options) => p.streamSimple(model, context, options),
    },
  }) as Provider;
}
