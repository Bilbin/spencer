import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "../../src/agent/credentials.ts";
import { COPILOT_PROVIDER, copilotOAuth, githubClientId, isCopilotCredential, pickCopilotModel, type CopilotCredential } from "../../src/agent/copilot.ts";
import { setupModels } from "../../src/agent/models.ts";
import { resolveConfig } from "../../src/config.ts";

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
