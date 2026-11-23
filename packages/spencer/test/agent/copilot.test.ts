import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "../../src/agent/credentials.ts";
import {
  COPILOT_PROVIDER,
  DEFAULT_GITHUB_CLIENT_ID,
  copilotOAuth,
  githubClientId,
  isCopilotCredential,
  parseCopilotModels,
  pickCopilotModel,
  type CopilotCredential,
} from "../../src/agent/copilot.ts";
import { ModelManager } from "../../src/agent/model-manager.ts";
import { setupModels } from "../../src/agent/models.ts";
import { resolveConfig, type ModelConfig } from "../../src/config.ts";
import type { CoreServices, DaemonEvent } from "../../src/contracts.ts";

const cred = (over: Partial<CopilotCredential> = {}): CopilotCredential => ({
  type: "oauth",
  access: "gho_test",
  refresh: "gho_test",
  expires: Date.now() + 3_600_000,
  login: "alice",
  plan: "individual",
  apiBase: "https://api.individual.githubcopilot.com",
  availableModelIds: ["claude-sonnet-5.5", "gpt-6.1-terra"],
  source: "device",
  ...over,
});

test("credentials survive a restart, owner-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-cred-"));
  const a = new FileCredentialStore(dir);
  await a.modify(COPILOT_PROVIDER, async () => cred());
  assert.equal(statSync(a.file).mode & 0o777, 0o600);
  const b = new FileCredentialStore(dir);
  assert.ok(isCopilotCredential(await b.read(COPILOT_PROVIDER)));
  assert.deepEqual(await b.list(), [{ providerId: COPILOT_PROVIDER, type: "oauth" }]);
  await b.delete(COPILOT_PROVIDER);
  assert.equal(await new FileCredentialStore(dir).read(COPILOT_PROVIDER), undefined);
  assert.deepEqual(JSON.parse(readFileSync(a.file, "utf8")), {});
});

test("a corrupt credentials file does not stop the daemon", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-cred-"));
  const a = new FileCredentialStore(dir);
  await a.modify("x", async () => ({ type: "api_key", key: "k" }));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(a.file, "{not json");
  assert.equal(await new FileCredentialStore(dir).read("x"), undefined);
});

test("GitHub client id: env over config over default, validated", () => {
  const prev = process.env.SPENCER_GITHUB_CLIENT_ID;
  try {
    delete process.env.SPENCER_GITHUB_CLIENT_ID;
    assert.equal(githubClientId(), DEFAULT_GITHUB_CLIENT_ID);
    assert.ok(DEFAULT_GITHUB_CLIENT_ID.startsWith("Ov23li"));
    assert.equal(githubClientId("Ov23liABC"), "Ov23liABC");
    assert.equal(githubClientId("bad id with spaces"), undefined);
    process.env.SPENCER_GITHUB_CLIENT_ID = "Ov23liENV";
    assert.equal(githubClientId("Ov23liABC"), "Ov23liENV");
  } finally {
    if (prev === undefined) delete process.env.SPENCER_GITHUB_CLIENT_ID;
    else process.env.SPENCER_GITHUB_CLIENT_ID = prev;
  }
  assert.throws(() => resolveConfig({ auth: { githubClientId: "no spaces allowed" } } as never), /githubClientId/);
  assert.equal(resolveConfig({ auth: { githubClientId: " Ov23li " } } as never).auth.githubClientId, "Ov23li");
});

test("the Copilot token goes to the account's own endpoint", async () => {
  const auth = await copilotOAuth(() => undefined).toAuth(cred({ apiBase: "https://api.business.githubcopilot.com" }));
  assert.deepEqual(auth, { apiKey: "gho_test", baseUrl: "https://api.business.githubcopilot.com" });
});

test("setupModels: Copilot needs a sign-in and a model the account has", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-cred-"));
  const credentials = new FileCredentialStore(dir);
  const opts = { name: () => "Spencer", credentials };
  const none = await setupModels({ provider: COPILOT_PROVIDER, modelId: "claude-sonnet-5.5" }, opts);
  assert.equal(none.ref, undefined);
  assert.match(none.error ?? "", /not connected/);

  await credentials.modify(COPILOT_PROVIDER, async () => cred());
  const ok = await setupModels({ provider: COPILOT_PROVIDER, modelId: "claude-sonnet-5.5" }, opts);
  assert.deepEqual(ok.ref, { provider: COPILOT_PROVIDER, modelId: "claude-sonnet-5.5" });
  // Requests identify as Spencer, not as VS Code.
  const model = ok.models.getModel(COPILOT_PROVIDER, "claude-sonnet-5.5")!;
  assert.match(String(model.headers?.["User-Agent"]), /^spencer\//);
  assert.equal(model.headers?.["Editor-Version"], undefined);
  assert.equal(model.headers?.["Copilot-Integration-Id"], undefined);
  // Only the account's models are offered.
  const available = (await ok.models.getAvailable(COPILOT_PROVIDER)).map((m) => m.id).sort();
  assert.deepEqual(available, ["claude-sonnet-5.5", "gpt-6.1-terra"]);

  const unknown = await setupModels({ provider: COPILOT_PROVIDER, modelId: "no-such-model" }, opts);
  assert.match(unknown.error ?? "", /unknown GitHub Copilot model/);
});

test("model picked after sign-in", () => {
  assert.equal(pickCopilotModel(["gpt-6.1-terra", "claude-sonnet-5.5"]), "claude-sonnet-5.5");
  assert.equal(pickCopilotModel(["claude-sonnet-9", "gpt-x"]), "claude-sonnet-9");
  assert.equal(pickCopilotModel(["gpt-x"]), "gpt-x");
  assert.equal(pickCopilotModel([]), undefined);
});

function makeModelManager(dir: string, initialModel: ModelConfig) {
  let cfg = resolveConfig({ model: initialModel } as never);
  const saved: ModelConfig[] = [];
  const events: DaemonEvent[] = [];
  let reloads = 0;
  const core = {
    dataDir: dir,
    config: () => cfg,
    saveModel: (m: ModelConfig) => {
      cfg = { ...cfg, model: m };
      saved.push(m);
    },
    events: { emit: (e: DaemonEvent) => events.push(e) },
  } as unknown as CoreServices;
  const mm = new ModelManager({
    core,
    name: () => "Spencer",
    log: () => {},
    onReload: async () => {
      reloads++;
    },
  });
  return { mm, saved, events, getReloads: () => reloads, getConfig: () => cfg };
}

test("ModelManager: lists providers, switches live with saved API key, and clears key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-mm-"));
  const prevAnt = process.env.ANTHROPIC_API_KEY;
  const prevOai = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const { mm, saved, getReloads } = makeModelManager(dir, {
    provider: "anthropic",
    modelId: "claude-sonnet-5-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  });
  try {
    await mm.init();
    const initial = mm.status();
    assert.equal(initial.ready, false);
    const providerIds = initial.providers?.map((p) => p.id) ?? [];
    assert.ok(providerIds.includes("github-copilot"));
    assert.ok(providerIds.includes("anthropic"));
    assert.ok(providerIds.includes("openai"));
    assert.ok(providerIds.includes("google"));
    assert.ok(providerIds.includes("openai-compatible"));
    const antCatalog = initial.providers?.find((p) => p.id === "anthropic");
    assert.ok((antCatalog?.models.length ?? 0) > 0);
    const antModelId = antCatalog!.models[0].id;

    // Save an API key via setModel: stored in secrets/credentials.json (0600), never in config.json.
    const st1 = await mm.setModel("anthropic", antModelId, { apiKey: "sk-ant-test-123", thinking: "high" });
    assert.equal(st1.ready, true);
    assert.equal(st1.provider, "anthropic");
    assert.equal(st1.modelId, antModelId);
    assert.equal(st1.thinking, "high");
    assert.equal(st1.providers?.find((p) => p.id === "anthropic")?.hasSavedKey, true);
    assert.equal(getReloads(), 1);
    assert.equal((saved.at(-1) as { apiKey?: string }).apiKey, undefined);
    assert.equal(statSync(mm.credentials.file).mode & 0o777, 0o600);
    assert.deepEqual(await mm.credentials.read("anthropic"), { type: "api_key", key: "sk-ant-test-123" });

    // Switch to another built-in provider (OpenAI) with its own saved key.
    const oaiModelId = initial.providers!.find((p) => p.id === "openai")!.models[0].id;
    const st2 = await mm.setModel("openai", oaiModelId, { apiKey: "sk-oai-test-456", thinking: "off" });
    assert.equal(st2.ready, true);
    assert.equal(st2.provider, "openai");
    assert.equal(st2.modelId, oaiModelId);
    assert.equal(st2.thinking, undefined);
    assert.equal(st2.providers?.find((p) => p.id === "openai")?.hasSavedKey, true);

    // Clear the saved key: credentials removed and status drops to not ready (no env var).
    const st3 = await mm.setModel("openai", oaiModelId, { clearApiKey: true });
    assert.equal(st3.ready, false);
    assert.equal(st3.providers?.find((p) => p.id === "openai")?.hasSavedKey, false);
    assert.equal(await mm.credentials.read("openai"), undefined);

    // Switch to openai-compatible (no key required for local servers like Ollama).
    const st4 = await mm.setModel("openai-compatible", "llama3.1", {
      baseUrl: "http://localhost:11434/v1/",
      thinking: "low",
    });
    assert.equal(st4.ready, true);
    assert.equal(st4.provider, "openai-compatible");
    assert.equal(st4.modelId, "llama3.1");
    assert.equal(st4.baseUrl, "http://localhost:11434/v1");
    assert.equal(st4.thinking, "low");

    // Validation errors.
    await assert.rejects(() => mm.setModel("no-such-provider", "m"), /unknown model provider/);
    await assert.rejects(() => mm.setModel("openai", "no-such-model"), /has no model/);
    await assert.rejects(() => mm.setModel("openai", oaiModelId, { thinking: "ultra" as never }), /thinking must be/);
    await assert.rejects(() => mm.setModel("openai-compatible", "llama3.1", { baseUrl: "ftp://bad" }), /http/);
  } finally {
    mm.stop();
    if (prevAnt === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnt;
    if (prevOai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOai;
  }
});

test("ModelManager: openai-compatible requires baseUrl when switching from another provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-mm-"));
  const { mm } = makeModelManager(dir, { provider: "fake" });
  try {
    await mm.init();
    await assert.rejects(() => mm.setModel("openai-compatible", "llama3.1"), /baseUrl is required/);
  } finally {
    mm.stop();
  }
});

test("parseCopilotModels: supports Business accounts with legacy/picker-false models and filters non-chat", () => {
  const parsed = parseCopilotModels({
    data: [
      { id: "text-embedding-3-small", name: "Embedding", capabilities: { type: "embeddings" } },
      { id: "no-tools", name: "No Tools", capabilities: { type: "chat", supports: { tool_calls: false } } },
      { id: "gpt-4o-mini-2024-07-18", name: "GPT-4o mini", model_picker_enabled: false, capabilities: { type: "chat", supports: { tool_calls: true } } },
      { id: "gpt-4o", name: "GPT-4o", model_picker_enabled: false, capabilities: { type: "chat", supports: { tool_calls: true, vision: true }, limits: { max_prompt_tokens: 128000, max_output_tokens: 4096 } } },
      { id: "gpt-4o", name: "GPT-4o duplicate", model_picker_enabled: false, capabilities: { type: "chat", supports: { tool_calls: true } } },
    ],
  });
  assert.deepEqual(
    parsed?.map((m) => ({ id: m.id, name: m.name, api: m.api, vision: m.vision })),
    [
      { id: "gpt-4o-mini-2024-07-18", name: "GPT-4o mini", api: "openai-completions", vision: undefined },
      { id: "gpt-4o", name: "GPT-4o", api: "openai-completions", vision: true },
    ],
  );
  const endpoints = parseCopilotModels({
    data: [
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", model_picker_enabled: true, supported_endpoints: ["/v1/messages", "/chat/completions"], capabilities: { type: "chat", supports: { tool_calls: true } } },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", model_picker_enabled: true, supported_endpoints: ["/responses"], capabilities: { type: "chat", supports: { tool_calls: true } } },
    ],
  });
  assert.equal(endpoints?.[0].api, "anthropic-messages");
  assert.equal(endpoints?.[1].api, "openai-responses");
});

test("Copilot live-discovered models outside pi-ai static catalog populate picker and work in setupModels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-mm-biz-"));
  const businessCred = cred({
    plan: "business",
    apiBase: "https://api.business.githubcopilot.com",
    availableModelIds: ["gpt-4o-mini-2024-07-18", "gpt-4o", "gpt-3.5-turbo"],
    availableModels: [
      { id: "gpt-4o-mini-2024-07-18", name: "GPT-4o mini", api: "openai-completions" },
      { id: "gpt-4o", name: "GPT-4o", api: "openai-completions", vision: true },
      { id: "gpt-3.5-turbo", name: "GPT 3.5 Turbo", api: "openai-completions" },
    ],
  });
  const store = new FileCredentialStore(dir);
  await store.modify(COPILOT_PROVIDER, async () => businessCred);

  const { mm } = makeModelManager(dir, { provider: "anthropic", modelId: "claude-sonnet-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" });
  try {
    await mm.init();
    const st = mm.status();
    assert.equal(st.copilot.connected, true);
    assert.deepEqual(
      st.copilot.models.map((m) => m.id),
      ["gpt-4o", "gpt-4o-mini-2024-07-18", "gpt-3.5-turbo"],
    );
    assert.deepEqual(
      st.providers?.find((p) => p.id === COPILOT_PROVIDER)?.models.map((m) => m.id),
      ["gpt-4o", "gpt-4o-mini-2024-07-18", "gpt-3.5-turbo"],
    );
    assert.equal(pickCopilotModel(st.copilot.models.map((m) => m.id)), "gpt-4o");

    const switched = await mm.setModel(COPILOT_PROVIDER, "gpt-4o");
    assert.equal(switched.ready, true);
    assert.equal(switched.provider, COPILOT_PROVIDER);
    assert.equal(switched.modelId, "gpt-4o");
    assert.equal(switched.thinking, undefined);
  } finally {
    mm.stop();
  }

  // Also works for credentials saved before `availableModels` existed (only `availableModelIds`).
  const legacyDir = mkdtempSync(join(tmpdir(), "spencer-mm-legacy-"));
  const legacyStore = new FileCredentialStore(legacyDir);
  await legacyStore.modify(COPILOT_PROVIDER, async () => cred({ availableModelIds: ["gpt-4o", "gpt-3.5-turbo"] }));
  const ok = await setupModels({ provider: COPILOT_PROVIDER, modelId: "gpt-4o" }, { name: () => "Spencer", credentials: legacyStore });
  assert.deepEqual(ok.ref, { provider: COPILOT_PROVIDER, modelId: "gpt-4o" });
  assert.equal(ok.models.getModel(COPILOT_PROVIDER, "gpt-4o")?.api, "openai-completions");
});
