// Soul view: edit SOUL.md, the personality every conversation of your Spencer is given.
import { h, icon } from "./dom.js";
import { api, attempt, toast } from "./api.js";
import { viewHeader } from "./common.js";

const TEMPLATE = `# Soul

## Core truths
- Be genuinely useful: do the thing, then say what you did.
- Have opinions and share them honestly, but hold them loosely.

## Boundaries
- Guard my privacy and my time.
- Ask me before anything irreversible.

## Vibe
- Warm, direct and concise. A little dry humor is welcome.
- Talk like a capable friend, not a corporate assistant.

## Continuity
- Remember what matters to me and build on what we have done before.
`;

const bytes = (s) => new TextEncoder().encode(s.trim()).length;

export function soulView(main) {
  const editor = h("textarea.input.soul-editor", {
    rows: "18",
    spellcheck: "true",
    placeholder: "Who is your Spencer? Its values, boundaries and voice, in Markdown.",
    "aria-label": "SOUL.md",
    disabled: true,
  });
  const count = h("span.soul-count", { "aria-live": "polite" });
  const save = h("button.btn.primary", { type: "button", disabled: true }, "Save");
  const revert = h("button.btn", { type: "button", disabled: true }, "Revert");
  const template = h("button.btn", { type: "button", hidden: true }, "Start from a template");

  main.append(
    viewHeader([h("span.title-icon", { "aria-hidden": "true" }, icon("heart", 18)), h("div.title-stack", null, h("h1", null, "Soul"), h("span.subtitle", null, "Your Spencer's personality"))]),
    h(
      "div.page",
      null,
      h(
        "div.page-body",
        null,
        h(
          "p.lede",
          null,
          "Describe who your Spencer is: its values, boundaries and voice. It is added to every conversation, yours and each channel's, so peers notice the personality but never see the text. It never overrides the trust rules.",
        ),
        editor,
        h("div.soul-actions", null, save, revert, template, count),
        h("p.model-foot", null, "Saved as ", h("code", null, "SOUL.md"), " in Spencer's data folder and applied right away. If you edit the file directly, restart Spencer."),
      ),
    ),
  );

  let saved = "";
  let maxBytes = 16 * 1024;
  let busy = false;

  const sync = () => {
    const n = bytes(editor.value);
    const over = n > maxBytes;
    const dirty = editor.value.trim() !== saved;
    count.textContent = `${(n / 1024).toFixed(1)} / ${maxBytes / 1024} KiB`;
    count.classList.toggle("over", over);
    save.disabled = busy || !dirty || over;
    revert.disabled = busy || !dirty;
    template.hidden = !!editor.value.trim();
  };

  const load = (r) => {
    saved = r.text ?? "";
    maxBytes = r.maxBytes ?? maxBytes;
    editor.value = saved;
    editor.disabled = false;
    sync();
  };

  const doSave = async () => {
    if (save.disabled) return;
    busy = true;
    sync();
    const r = await attempt(() => api.setSoul(editor.value));
    busy = false;
    if (r) {
      load(r);
      toast(r.text ? "Soul saved. Your Spencer uses it from now on." : "Soul removed.", "info");
    } else sync();
  };

  editor.addEventListener("input", sync);
  editor.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      void doSave();
    }
  });
  save.addEventListener("click", () => void doSave());
  revert.addEventListener("click", () => {
    editor.value = saved;
    sync();
  });
  template.addEventListener("click", () => {
    editor.value = TEMPLATE;
    sync();
    editor.focus();
  });

  sync();
  attempt(() => api.soul()).then((r) => r && load(r));
  return { destroy() {} };
}
