// Model & settings view: pick any provider/model/thinking effort live, and sign in to GitHub Copilot.
import { h, icon, copyText } from "./dom.js";
import { api, attempt, toast } from "./api.js";
import { S, on, setModel } from "./state.js";
import { viewHeader } from "./common.js";

const PLAN = { individual: "Copilot Pro", individual_pro: "Copilot Pro+", business: "Copilot Business", enterprise: "Copilot Enterprise", free: "Copilot Free" };
const planName = (p) => PLAN[p] ?? (p ? `Copilot ${p}` : "Copilot");

const PROVIDER = {
  "github-copilot": "GitHub Copilot",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  xai: "xAI",
  groq: "Groq",
  deepseek: "DeepSeek",
  "openai-compatible": "OpenAI-compatible server",
  fake: "Test model",
};

const THINKING_OPTIONS = [
  ["off", "Off"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
];

/** Model id → display name from the active provider's catalog, when known. */
export function modelName(status = S.model) {
  if (!status?.modelId) return null;
  const prov = status.providers?.find((p) => p.id === status.provider);
  return prov?.models?.find((m) => m.id === status.modelId)?.name ?? status.copilot?.models?.find((m) => m.id === status.modelId)?.name ?? status.modelId;
}

function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function modelView(main) {
  const now = h("section.model-now", { "aria-live": "polite" });
  const picker = h("section.model-card", { "aria-labelledby": "picker-title" });
  const copilot = h("section.model-card", { "aria-labelledby": "copilot-title" });
  main.append(
    viewHeader([
      h("span.title-icon", { "aria-hidden": "true" }, icon("spark", 18)),
      h("div.title-stack", null, h("h1", null, "Model & settings"), h("span.subtitle", null, "Pick a provider, model, and thinking level")),
    ]),
    h(
      "div.page",
      null,
      h(
        "div.page-body",
        null,
        now,
        h("h2.section-title", { id: "picker-title" }, "Model picker"),
        picker,
        h("h2.section-title", { id: "copilot-title" }, "GitHub Copilot"),
        copilot,
        h("p.model-foot", null, "Changes take effect immediately without restarting Spencer. Saved API keys live in ", h("code", null, "secrets/credentials.json"), " (mode 0600), never in config.json."),
      ),
    ),
  );

  let busy = false;
  let tick = null;
  // Draft picker state so background model events don't wipe what the user is typing.
  const draft = { provider: "", modelId: "", filter: "", thinking: "off", baseUrl: "", apiKey: "", initialized: false, lastKey: "", wasConnected: false };

  const syncDraftFromModel = (m, force = false) => {
    if (!m) return;
    const connected = !!m.copilot?.connected;
    const copilotSig = (m.copilot?.models ?? []).map((x) => `${x.id}:${x.name}`).join(",");
    const key = `${m.provider ?? ""}|${m.modelId ?? ""}|${m.thinking ?? ""}|${m.baseUrl ?? ""}|${m.ready ? "1" : "0"}|${connected ? "1" : "0"}|${m.copilot?.modelsRefreshedAt ?? ""}|${m.copilot?.modelsError ?? ""}|${copilotSig}`;
    if (!force && draft.initialized && draft.lastKey === key) return;
    const justConnected = !draft.wasConnected && connected;
    const providers = m.providers ?? [];
    const fallbackProv = connected ? "github-copilot" : (providers[0]?.id ?? "anthropic");
    if (justConnected && (draft.provider === "github-copilot" || m.provider === "github-copilot")) {
      draft.provider = "github-copilot";
    } else if (draft.initialized && !force && draft.provider === "github-copilot" && connected) {
      draft.provider = "github-copilot";
    } else {
      draft.provider = providers.some((p) => p.id === m.provider) ? m.provider : fallbackProv;
    }
    const prov = providers.find((p) => p.id === draft.provider);
    if (draft.provider === m.provider && m.modelId && (!prov?.models?.length || prov.models.some((x) => x.id === m.modelId))) {
      draft.modelId = m.modelId;
    } else {
      draft.modelId = prov?.models?.[0]?.id ?? "";
    }
    const needsThinking = draft.provider === "github-copilot" && /^claude-/i.test(draft.modelId);
    draft.thinking = m.thinking ?? (needsThinking ? "medium" : "off");
    draft.baseUrl = m.baseUrl ?? "";
    draft.apiKey = "";
    draft.filter = "";
    draft.initialized = true;
    draft.wasConnected = connected;
    draft.lastKey = key;
  };

  const act = async (fn, successMsg) => {
    if (busy) return;
    busy = true;
    render();
    const r = await attempt(fn);
    busy = false;
    if (r && typeof r === "object" && "copilot" in r) {
      syncDraftFromModel(r, true);
      setModel(r);
      if (successMsg) toast(typeof successMsg === "function" ? successMsg(r) : successMsg, "info");
    } else render();
    return r;
  };

  const refreshCopilot = () =>
    act(
      () => api.copilotRefresh(),
      (r) => `Refreshed ${r.copilot?.models?.length ?? 0} GitHub Copilot models`,
    );

  const renderNow = (m) => {
    if (!m) return now.replaceChildren(h("p.muted", null, "Loading…"));
    const name = modelName(m);
    const provName = m.providers?.find((p) => p.id === m.provider)?.name ?? PROVIDER[m.provider] ?? m.provider;
    now.replaceChildren(
      h(`span.dot.${m.ready ? "connected" : "error"}`, { "aria-hidden": "true" }),
      h(
        "div.model-now-text",
        null,
        h("div.model-now-name", null, name ?? "No model"),
        h(
          "div.model-now-sub",
          null,
          provName ? `via ${provName}` : null,
          m.thinking && m.thinking !== "off" ? h("span.pill.muted", null, `thinking: ${m.thinking}`) : null,
          m.ready ? h("span.pill.ok", null, "Ready") : h("span.pill.bad", null, "Not ready"),
        ),
        !m.ready && m.error ? h("p.model-error", null, m.error.replace(/^./, (c) => c.toUpperCase())) : null,
      ),
    );
  };

  const renderPicker = (m) => {
    const providers = m.providers ?? [];
    if (!providers.length) {
      picker.replaceChildren(h("p.muted", null, "No model providers available."));
      return;
    }
    if (!providers.some((p) => p.id === draft.provider)) draft.provider = providers[0].id;
    const prov = providers.find((p) => p.id === draft.provider) ?? providers[0];
    const isCopilot = prov.id === "github-copilot";
    const isCustom = !!prov.custom;

    const providerSelect = h(
      "select.input.model-select",
      {
        "aria-label": "Provider",
        disabled: busy,
        on: {
          change: (e) => {
            draft.provider = e.target.value;
            draft.filter = "";
            draft.apiKey = "";
            const nextProv = providers.find((p) => p.id === draft.provider);
            if (draft.provider === m.provider && m.modelId) draft.modelId = m.modelId;
            else draft.modelId = nextProv?.models?.[0]?.id ?? "";
            if (draft.provider === "github-copilot" && /^claude-/i.test(draft.modelId) && draft.thinking === "off") draft.thinking = "medium";
            if (draft.provider === "openai-compatible" && !draft.baseUrl) draft.baseUrl = m.baseUrl ?? "http://localhost:11434/v1";
            renderPicker(m);
          },
        },
      },
      providers.map((p) => {
        const tag =
          p.id === "github-copilot"
            ? m.copilot?.connected
              ? " (connected)"
              : ""
            : p.hasEnvKey || p.hasSavedKey
              ? " (key ready)"
              : "";
        return h("option", { value: p.id, selected: p.id === prov.id }, `${p.name}${tag}`);
      }),
    );

    const copilotClaude = isCopilot && /^claude-/i.test(draft.modelId);
    const thinkingSelect = h(
      "select.input.model-select",
      {
        "aria-label": "Thinking effort",
        disabled: busy,
        on: { change: (e) => (draft.thinking = e.target.value) },
      },
      THINKING_OPTIONS.filter(([v]) => !copilotClaude || v !== "off").map(([v, label]) =>
        h("option", { value: v, selected: draft.thinking === v || (copilotClaude && draft.thinking === "off" && v === "medium") }, label),
      ),
    );

    let modelField;
    let extraFields = [];
    let canSave = true;

    if (isCustom) {
      const urlInput = h("input.input.mono", {
        type: "url",
        placeholder: "http://localhost:11434/v1",
        value: draft.baseUrl,
        disabled: busy,
        on: { input: (e) => (draft.baseUrl = e.target.value) },
      });
      const idInput = h("input.input.mono", {
        type: "text",
        placeholder: "e.g. llama3.1",
        value: draft.modelId,
        disabled: busy,
        on: { input: (e) => (draft.modelId = e.target.value) },
      });
      modelField = h("label.model-pick-label", null, "Model ID", idInput);
      extraFields.push(h("label.model-pick-label", null, "Base URL", urlInput));
    } else if (isCopilot && !m.copilot?.connected) {
      canSave = false;
      modelField = h("p.signin-note", null, "Sign in to GitHub Copilot below to see and pick your Copilot models.");
    } else {
      const allModels = prov.models ?? [];
      const q = draft.filter.trim().toLowerCase();
      const filtered = q ? allModels.filter((x) => x.id.toLowerCase().includes(q) || x.name.toLowerCase().includes(q)) : allModels;
      if (filtered.length && !filtered.some((x) => x.id === draft.modelId)) draft.modelId = filtered[0].id;

      const modelSelect = h(
        "select.input.model-select",
        {
          "aria-label": "Model",
          disabled: busy || !filtered.length,
          on: {
            change: (e) => {
              draft.modelId = e.target.value;
              if (isCopilot && /^claude-/i.test(draft.modelId) && draft.thinking === "off") {
                draft.thinking = "medium";
                renderPicker(m);
              }
            },
          },
        },
        filtered.length
          ? filtered.map((x) => h("option", { value: x.id, selected: x.id === draft.modelId }, x.name === x.id ? x.id : `${x.name} (${x.id})`))
          : [h("option", { value: "" }, q ? "No matching models" : "No models available")],
      );

      const modelLabel = isCopilot ? `Model (${allModels.length} available)` : "Model";
      if (allModels.length > 15) {
        const filterInput = h("input.input.model-filter", {
          type: "search",
          placeholder: `Filter ${allModels.length} models…`,
          value: draft.filter,
          disabled: busy,
          on: {
            input: (e) => {
              draft.filter = e.target.value;
              const pos = e.target.selectionStart;
              renderPicker(m);
              const again = picker.querySelector(".model-filter");
              if (again) {
                again.focus();
                if (pos !== null) again.setSelectionRange(pos, pos);
              }
            },
          },
        });
        modelField = h("div.model-pick-stack", null, h("label.model-pick-label", null, modelLabel, filterInput, modelSelect));
      } else {
        modelField = h("label.model-pick-label", null, modelLabel, modelSelect);
      }
      if (isCopilot && m.copilot?.modelsError) {
        extraFields.push(h("p.model-error", null, m.copilot.modelsError));
      }
      if (!filtered.length) canSave = false;
    }

    if (!isCopilot) {
      const envName = (m.provider === prov.id && m.apiKeyEnv) || prov.defaultApiKeyEnv;
      const keyStatus = prov.hasSavedKey
        ? "API key saved locally (mode 0600)."
        : prov.hasEnvKey && envName
          ? `Using ${envName} from environment.`
          : isCustom
            ? "Optional for local servers like Ollama."
            : envName
              ? `No key found in ${envName}. Paste one below or set ${envName} in the environment.`
              : "Paste an API key below if required.";
      const keyInput = h("input.input.mono", {
        type: "password",
        autocomplete: "off",
        placeholder: prov.hasSavedKey ? "Enter a new key to replace saved key…" : "Paste API key…",
        value: draft.apiKey,
        disabled: busy,
        on: { input: (e) => (draft.apiKey = e.target.value) },
      });
      const clearBtn = prov.hasSavedKey
        ? h(
            "button.btn.sm.ghost",
            {
              type: "button",
              disabled: busy,
              on: {
                click: () => {
                  const id = draft.modelId.trim() || prov.models?.[0]?.id || m.modelId || "";
                  if (!id) return toast("Pick a model first");
                  void act(
                    () =>
                      api.setModel(prov.id, id, {
                        clearApiKey: true,
                        ...(isCustom ? { baseUrl: draft.baseUrl.trim() || m.baseUrl || "http://localhost:11434/v1" } : {}),
                      }),
                    "Saved API key removed",
                  );
                },
              },
            },
            "Remove saved key",
          )
        : null;
      extraFields.push(
        h(
          "div.model-key-block",
          null,
          h("label.model-pick-label", null, isCustom ? "API key (optional)" : "API key", keyInput),
          h("div.model-key-status", null, h("span", null, keyStatus), clearBtn),
        ),
      );
    }

    const saveBtn = h("button.btn.primary", { type: "submit", disabled: busy || !canSave }, "Save & switch");
    const refreshBtn =
      isCopilot && m.copilot?.connected
        ? h("button.btn", { type: "button", disabled: busy, on: { click: () => void refreshCopilot() } }, "Refresh models")
        : null;
    const form = h(
      "form.model-form",
      {
        on: {
          submit: (e) => {
            e.preventDefault();
            const mid = draft.modelId.trim();
            if (!mid) return toast("Pick or enter a model ID");
            if (isCustom && !draft.baseUrl.trim()) return toast("Base URL is required for OpenAI-compatible servers");
            const opts = {
              thinking: isCopilot && /^claude-/i.test(mid) && draft.thinking === "off" ? "medium" : draft.thinking,
              ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
              ...(isCustom ? { baseUrl: draft.baseUrl.trim() } : {}),
            };
            void act(() => api.setModel(prov.id, mid, opts), `Switched model to ${mid}`);
          },
        },
      },
      h("div.model-row", null, h("label.model-pick-label", null, "Provider", providerSelect), h("label.model-pick-label.sm", null, "Thinking", thinkingSelect)),
      modelField,
      ...extraFields,
      h("div.model-actions", null, saveBtn, refreshBtn),
    );
    picker.replaceChildren(form);
  };

  const signInBox = (c) => {
    const si = c.signIn;
    if (si?.state === "waiting") {
      const left = h("span.model-countdown");
      const update = () => (left.textContent = si.expiresAt ? `The code expires in ${mmss(si.expiresAt - Date.now())}.` : "");
      update();
      clearInterval(tick);
      tick = setInterval(update, 1000);
      return h(
        "div.device",
        null,
        h("p.device-step", null, "Enter this code on GitHub to let Spencer use your Copilot:"),
        h(
          "div.device-code-row",
          null,
          h("code.device-code", { "aria-label": `Code ${si.userCode.split("").join(" ")}` }, si.userCode),
          h(
            "button.btn.sm",
            {
              type: "button",
              on: { click: async () => toast((await copyText(si.userCode)) ? "Code copied" : "Couldn't copy the code", "info") },
            },
            icon("copy", 14),
            "Copy",
          ),
        ),
        h(
          "div.device-actions",
          null,
          h("a.btn.primary", { href: si.verificationUri, target: "_blank", rel: "noopener noreferrer" }, "Open GitHub", icon("chevron", 14)),
          h("button.btn.ghost", { type: "button", on: { click: () => act(() => api.copilotCancel()) } }, "Cancel"),
        ),
        h("p.device-wait", null, h("span.device-wait-text", null, "Waiting for you to approve on GitHub. "), left),
      );
    }
    clearInterval(tick);
    if (si?.state === "connecting") return h("div.device", null, h("p.device-wait", null, h("span.device-wait-text", null, "Signed in. Checking your Copilot subscription…")));
    const deviceBtn = h(
      "button.btn.primary",
      { type: "button", disabled: busy || !c.deviceLogin, on: { click: () => act(() => api.copilotLogin()) } },
      "Sign in with GitHub",
    );
    return h(
      "div.signin",
      null,
      si?.state === "failed" ? h("p.model-error", null, si.error ?? "Sign-in failed.") : null,
      h("p.signin-lede", null, "Use the Copilot subscription you already pay for. Spencer pairs via GitHub device code, or reuses your GitHub Copilot CLI sign-in, and talks to Copilot directly."),
      h("div.signin-actions", null, ...cliButtons(c, "primary"), deviceBtn),
      c.deviceLogin ? null : h("p.signin-note", null, "Sign in with GitHub needs a GitHub OAuth app id (", h("code", null, "auth.githubClientId"), " in config.json)."),
    );
  };

  // Reuse the GitHub Copilot CLI's sign-in: GitHub's own client, which some Business/Enterprise policies give more models.
  const cliButtons = (c, kind = "") =>
    (c.cliAccounts ?? [])
      .filter((login) => !(c.connected && c.via === "copilot-cli" && c.login === login))
      .map((login) =>
        h(
          `button.btn${kind ? `.${kind}` : ".sm"}`,
          {
            type: "button",
            disabled: busy,
            on: { click: () => act(() => api.copilotCli(login), (r) => `Using the Copilot CLI sign-in: ${r.copilot?.models?.length ?? 0} models`) },
          },
          `Use Copilot CLI sign-in (@${login})`,
        ),
      );

  const connectedBox = (m) => {
    const c = m.copilot;
    const onCopilot = m.provider === "github-copilot";
    return h(
      "div.connected",
      null,
      h(
        "div.account",
        null,
        h("span.dot.connected", { "aria-hidden": "true" }),
        h("span.account-name", null, `@${c.login}`),
        h("span.pill.muted", null, planName(c.plan)),
        c.via === "copilot-cli" ? h("span.pill.muted", null, "via Copilot CLI") : null,
        h(
          "div.account-actions",
          null,
          h("button.btn.sm", { type: "button", disabled: busy, on: { click: () => void refreshCopilot() } }, "Refresh models"),
          h("button.btn.sm.ghost", { type: "button", disabled: busy, on: { click: () => act(() => api.copilotLogout(), "Signed out of GitHub Copilot") } }, "Sign out"),
        ),
      ),
      c.modelsError ? h("p.model-error", null, c.modelsError) : null,
      (() => {
        const btns = cliButtons(c);
        return btns.length ? h("div.signin-actions", null, ...btns) : null;
      })(),
      !onCopilot && c.models.length
        ? h(
            "div.signin-actions",
            null,
            h(
              "button.btn.sm",
              {
                type: "button",
                disabled: busy,
                on: {
                  click: () => {
                    draft.provider = "github-copilot";
                    draft.modelId = c.models[0].id;
                    draft.thinking = /^claude-/i.test(draft.modelId) ? (draft.thinking === "off" ? "medium" : draft.thinking) : "off";
                    renderPicker(m);
                  },
                },
              },
              "Select Copilot in picker above",
            ),
          )
        : null,
    );
  };

  const render = () => {
    const m = S.model;
    renderNow(m);
    if (!m) {
      picker.replaceChildren();
      copilot.replaceChildren();
      return;
    }
    syncDraftFromModel(m);
    renderPicker(m);
    copilot.replaceChildren(m.copilot.connected ? connectedBox(m) : signInBox(m.copilot));
  };

  render();
  attempt(() => api.model()).then((r) => r && setModel(r));
  const off = on("model", render);
  return {
    destroy: () => {
      clearInterval(tick);
      off();
    },
  };
}
