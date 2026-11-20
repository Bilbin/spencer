// Generic modal dialog.
import { h, iconButton } from "./dom.js";

let current = null;

/**
 * openModal({title, body: Node|Node[], footer?: Node[], wide?}) → {close, el}
 * Escape or a backdrop click closes it. Focus returns to the previously focused element.
 */
export function openModal({ title, body, footer, wide = false, onClose }) {
  current?.close();
  const root = document.getElementById("modal-root");
  const prevFocus = document.activeElement;
  const titleId = `modal-title-${Math.random().toString(36).slice(2)}`;
  const close = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    if (current?.el === overlay) current = null;
    onClose?.();
    if (prevFocus instanceof HTMLElement && prevFocus.isConnected) prevFocus.focus();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      trapFocus(e, dialog);
    }
  };
  const dialog = h(
    `div.modal${wide ? ".wide" : ""}`,
    { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
    h("div.modal-head", null, h("h2", { id: titleId }, title), iconButton("close", "Close", () => close())),
    h("div.modal-body", null, body),
    footer ? h("div.modal-foot", null, footer) : null,
  );
  const overlay = h("div.overlay", { on: { mousedown: (e) => e.target === overlay && close() } }, dialog);
  root.append(overlay);
  document.addEventListener("keydown", onKey, true);
  requestAnimationFrame(() => {
    const first =
      dialog.querySelector("[data-autofocus]") ??
      dialog.querySelector("input:not([type=hidden]):not([readonly]), textarea, select, .modal-body button, .modal-foot button");
    (first ?? dialog.querySelector("button"))?.focus();
  });
  current = { close, el: overlay };
  return current;
}

export function closeModal() {
  current?.close();
}

function trapFocus(e, container) {
  const items = [...container.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
    (el) => !el.disabled && el.offsetParent !== null,
  );
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Labeled form field. */
export function field(label, control, hint) {
  const id = control.id || `f-${Math.random().toString(36).slice(2)}`;
  control.id = id;
  return h("div.field", null, h("label", { for: id }, label), control, hint ? h("p.hint", null, hint) : null);
}
