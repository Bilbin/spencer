// Model view: which model Spencer thinks with, and signing in to GitHub Copilot.
import { h, icon, copyText } from "./dom.js";
import { api, attempt, toast } from "./api.js";
import { S, on, setModel } from "./state.js";
import { viewHeader } from "./common.js";

const PLAN = { individual: "Copilot Pro", individual_pro: "Copilot Pro+", business: "Copilot Business", enterprise: "Copilot Enterprise", free: "Copilot Free" };
const planName = (p) => PLAN[p] ?? (p ? `Copilot ${p}` : "Copilot");

/** "claude-sonnet-5.5" → the catalog's display name, when known. */
export function modelName(status = S.model) {
  if (!status?.modelId) return null;
  return status.copilot?.models?.find((m) => m.id === status.modelId)?.name ?? status.modelId;
}

const PROVIDER = { "github-copilot": "GitHub Copilot", anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", google: "Google", "openai-compatible": "OpenAI-compatible server", fake: "Test model" };

function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function modelView(main) {
  const now = h("section.model-now", { "aria-live": "polite" });
  const copilot = h("section.model-card", { "aria-labelledby": "copilot-title" });
  main.append(
    viewHeader([h("span.title-icon", { "aria-hidden": "true" }, icon("spark", 18)), h("div.title-stack", null, h("h1", null, "Model"), h("span.subtitle", null, "What your Spencer thinks with"))]),
    h(
      "div.page",
      null,
      h(
        "div.page-body",
        null,
        now,
        h("h2.section-title", { id: "copilot-title" }, "GitHub Copilot"),
        copilot,
        h("p.model-foot", null, "Anthropic, OpenAI, OpenRouter and local servers are set under ", h("code", null, "model"), " in Spencer's config.json."),
      ),
    ),
  );

  let busy = false;
  let tick = null;
  const act = async (fn) => {
    if (busy) return;
    busy = true;
    render();
    const r = await attempt(fn);
    busy = false;
    if (r && typeof r === "object" && "copilot" in r) setModel(r);
    else render();
    return r;
  };

  const renderNow = (m) => {
    if (!m) return now.replaceChildren(h("p.muted", null, "Loading…"));
    const name = modelName(m);
    now.replaceChildren(
      h(`span.dot.${m.ready ? "connected" : "error"}`, { "aria-hidden": "true" }),
      h(
        "div.model-now-text",
        null,
        h("div.model-now-name", null, name ?? "No model"),
        h("div.model-now-sub", null, m.provider ? `via ${PROVIDER[m.provider] ?? m.provider}` : null, m.ready ? h("span.pill.ok", null, "Ready") : h("span.pill.bad", null, "Not ready")),
        !m.ready && m.error ? h("p.model-error", null, m.error.replace(/^./, (c) => c.toUpperCase())) : null,
      ),
    );
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
      h("p.signin-lede", null, "Use the Copilot subscription you already pay for. Spencer signs in to GitHub and talks to Copilot directly."),
      h("div.signin-actions", null, deviceBtn),
      c.deviceLogin ? null : h("p.signin-note", null, "Sign in with GitHub needs Spencer's GitHub app id (", h("code", null, "auth.githubClientId"), " in config.json). You can reuse a GitHub CLI login instead."),
      c.ghAccounts?.length
        ? h(
            "div.gh-cli",
            null,
            h("p.gh-cli-title", null, c.deviceLogin ? "Or reuse your GitHub CLI login" : "Reuse your GitHub CLI login"),
            h(
              "div.gh-cli-list",
              null,
              c.ghAccounts.map((a) =>
                h(
                  "button.btn.sm",
                  { type: "button", disabled: busy, on: { click: () => act(() => api.copilotGh(a.login)) } },
                  icon("terminal", 14),
                  `@${a.login}`,
                  a.active ? h("span.muted", null, " (active)") : null,
                ),
              ),
            ),
          )
        : c.deviceLogin
          ? null
          : h("p.signin-note", null, "No GitHub CLI login found. Install the GitHub CLI and run ", h("code", null, "gh auth login"), ", then come back."),
    );
  };

  const connectedBox = (m) => {
    const c = m.copilot;
    const onCopilot = m.provider === "github-copilot";
    const select = h(
      "select.input.model-select",
      { "aria-label": "Copilot model", disabled: busy },
      c.models.map((x) => h("option", { value: x.id, selected: onCopilot && x.id === m.modelId }, x.name)),
    );
    if (!onCopilot && !select.value) select.selectedIndex = 0;
    const use = h("button.btn.primary", { type: "button", disabled: busy }, onCopilot ? "Switch" : "Use Copilot");
    const sync = () => (use.disabled = busy || (onCopilot && select.value === m.modelId));
    select.addEventListener("change", sync);
    use.addEventListener("click", () => act(() => api.setModel("github-copilot", select.value)));
    sync();
    return h(
      "div.connected",
      null,
      h(
        "div.account",
        null,
        h("span.dot.connected", { "aria-hidden": "true" }),
        h("span.account-name", null, `@${c.login}`),
        h("span.pill.muted", null, planName(c.plan)),
        c.via === "gh-cli" ? h("span.account-via", null, "via GitHub CLI") : null,
        h("button.btn.sm.ghost.account-out", { type: "button", disabled: busy, on: { click: () => act(() => api.copilotLogout()) } }, "Sign out"),
      ),
      c.models.length
        ? h("div.model-pick", null, h("label.model-pick-label", null, "Model", select), use)
        : h("p.model-error", null, "Copilot lists no models for this account."),
    );
  };

  const render = () => {
    const m = S.model;
    renderNow(m);
    if (!m) return copilot.replaceChildren();
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
