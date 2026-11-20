// DOM helpers. Everything is built with createElement/textContent: message text comes
// from untrusted peers, so nothing here ever touches innerHTML.

/**
 * h("div.cls1.cls2", {attrs, on: {click}}, ...children)
 * Children: strings (become text nodes), nodes, arrays, null/false (skipped).
 */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el, props) {
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "on") {
      for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    } else if (k === "class") {
      el.className = el.className ? `${el.className} ${v}` : v;
    } else if (k === "text") {
      el.textContent = String(v);
    } else if (k === "dataset") {
      Object.assign(el.dataset, v);
    } else if (k === "value" || k === "checked" || k === "disabled" || k === "readOnly" || k === "selected") {
      el[k] = v;
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ---------------------------------------------------------------- icons (SVG via createElementNS)

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
  gear: [
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  ],
  send: ["M22 2 11 13", "M22 2l-7 20-4-9-9-4 20-7z"],
  paperclip: ["M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"],
  close: ["M18 6 6 18", "M6 6l12 12"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  up: ["M12 19V5", "M5 12l7-7 7 7"],
  down: ["M12 5v14", "M19 12l-7 7-7-7"],
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 6v6l4 2"],
  check: ["M20 6 9 17l-5-5"],
  plus: ["M12 5v14", "M5 12h14"],
  link: ["M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7", "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"],
  transfer: ["M7 17V3", "M3 7l4-4 4 4", "M17 7v14", "M21 17l-4 4-4-4"],
  plug: ["M9 2v6", "M15 2v6", "M6 8h12v4a6 6 0 0 1-12 0z", "M12 18v4"],
  bot: ["M12 8V4", "M8 4h8", "M5 8h14v11H5z", "M9 13h.01", "M15 13h.01"],
  users: ["M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M23 21v-2a4 4 0 0 0-3-3.9", "M16 3.1a4 4 0 0 1 0 7.8"],
  file: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6"],
  eye: ["M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  image: ["M3 3h18v18H3z", "M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z", "M21 15l-5-5L5 21"],
  warn: ["M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z", "M12 9v4", "M12 17h.01"],
};

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  for (const d of ICONS[name] ?? []) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/** A button that shows only an icon; label becomes aria-label and title. */
export function iconButton(name, label, onClick, cls = "") {
  return h(`button.icon-btn${cls ? "." + cls : ""}`, { type: "button", "aria-label": label, title: label, on: { click: onClick } }, icon(name));
}

// ---------------------------------------------------------------- formatting

export function shortFp(fp) {
  if (!fp) return "";
  return fp.split("-").slice(0, 2).join("-");
}

export function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function timeShort(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? t : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${t}`;
}

export function timeFull(ts) {
  return new Date(ts).toLocaleString();
}

export function relTime(ts) {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const units = [
    ["day", 86400000],
    ["hour", 3600000],
    ["minute", 60000],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [u, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), u);
  return rtf.format(Math.round(diff / 1000), "second");
}

export function initials(name) {
  const words = String(name || "?").replace(/'s\b/gi, "").split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => [...w][0] ?? "");
  return (letters.join("") || "?").toUpperCase();
}

/** Stable hue for a string, used for avatar colors. */
export function hue(str) {
  let x = 0;
  for (const c of String(str)) x = (x * 31 + c.codePointAt(0)) >>> 0;
  return x % 360;
}

export function avatar(name, seed, cls = "") {
  const el = h(`span.avatar${cls ? "." + cls : ""}`, { "aria-hidden": "true" }, initials(name));
  el.style.setProperty("--h", String(hue(seed ?? name)));
  return el;
}

/** Avatar for the owner's own Spencer (a bot glyph, so it doesn't depend on the loaded name). */
export function selfAvatar(cls = "") {
  const size = cls.includes("big") ? 30 : cls.includes("sm") ? 16 : 19;
  return h(`span.avatar.self${cls ? "." + cls : ""}`, { "aria-hidden": "true" }, icon("bot", size));
}

// ---------------------------------------------------------------- rich-ish text

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;

/** Text with http(s) URLs turned into safe links. Returns an array of nodes. */
export function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    let href = m[0];
    try {
      const u = new URL(href);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
      out.push(h("a", { href: u.href, target: "_blank", rel: "noopener noreferrer" }, href));
    } catch {
      out.push(document.createTextNode(href));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/**
 * Text with @mentions highlighted (known member names, longest first, then generic @word)
 * and http(s) URLs linkified.
 */
export function richText(text, names = [], myNames = []) {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  const mine = new Set(myNames.filter(Boolean).map((n) => n.toLowerCase()));
  const out = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) out.push(...linkify(buf));
    buf = "";
  };
  while (i < text.length) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : " ";
    if (ch === "@" && !/[\w@]/.test(prev)) {
      const rest = text.slice(i + 1);
      let matched = sorted.find((n) => rest.toLowerCase().startsWith(n.toLowerCase()) && !/\w/.test(rest[n.length] ?? " "));
      let len = matched ? matched.length : 0;
      if (!matched) {
        const m = /^[\w.-]*\w/.exec(rest);
        if (m) {
          matched = m[0];
          len = m[0].length;
        }
      }
      if (matched) {
        flush();
        const label = text.slice(i, i + 1 + len);
        out.push(h(`span.mention${mine.has(matched.toLowerCase()) ? ".me" : ""}`, null, label));
        i += 1 + len;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for contexts without the async clipboard API.
    const ta = h("textarea", { readonly: true, class: "offscreen" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Grow a textarea with its content, up to its CSS max-height. */
export function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
}
