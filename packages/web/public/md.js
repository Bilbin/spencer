// A small Markdown renderer that builds DOM nodes directly. Message text comes from untrusted peers, so
// nothing here touches innerHTML: every piece of text ends up in a text node, links are http(s)/mailto only,
// images are shown as links (no remote loads), and ```html blocks are previewed only on request, inside a
// sandboxed iframe (no scripts, opaque origin).
//
// Supported: paragraphs (single newlines kept), # headings, **bold**, *italic*, ~~strike~~, `code`,
// ``` fenced code ```, > quotes, - / 1. lists (nested, - [ ] tasks), tables, --- rules, [links](url), autolinks.
import { h, icon, copyText } from "./dom.js";

const MAX_DEPTH = 8;
const MAX_MARKDOWN_LINES = 100_002;
const MAX_MARKDOWN_BLOCKS = 2000;
const MAX_MARKDOWN_LIST_ITEMS = 1000;
const MAX_PREVIEW_INLINE_MARKERS = 1024;
const MAX_COMPLEX_INLINE_LENGTH = 128;
const MAX_COMPLEX_INLINE_MARKERS = 24;
const plainLeaf = (s) => [document.createTextNode(s)];

/**
 * Render `src` as Markdown. `leaf(text)` turns a run of plain text into nodes (e.g. mention highlighting and
 * URL linkifying); the default is plain text. Returns a DocumentFragment-like array of nodes.
 */
export function markdown(src, leaf = plainLeaf, options = {}) {
  try {
    const preview = options.htmlPreview === false;
    const normalized = String(src ?? "").replace(/\r\n?/g, "\n");
    const lines = preview ? normalized.split("\n", MAX_MARKDOWN_LINES + 1) : normalized.split("\n");
    const truncated = preview && lines.length > MAX_MARKDOWN_LINES;
    if (truncated) lines.length = MAX_MARKDOWN_LINES;
    const renderOptions = preview
      ? {
          ...options,
          preview: true,
          blockBudget: { remaining: MAX_MARKDOWN_BLOCKS },
          listItemBudget: { remaining: MAX_MARKDOWN_LIST_ITEMS },
          tableCellBudget: { remaining: MAX_TABLE_CELLS },
          inlineMarkerBudget: { remaining: MAX_PREVIEW_INLINE_MARKERS },
          inlineFallback: { used: false },
        }
      : options;
    const rendered = blocks(lines, leaf, 0, renderOptions);
    if (truncated) rendered.push(h("p.md-truncated", null, "Markdown preview truncated because it is too long."));
    if (renderOptions.inlineFallback?.used) rendered.push(h("p.md-truncated", null, "Some inline Markdown was shown as text to keep the preview responsive."));
    return rendered;
  } catch (err) {
    console.error("markdown render failed", err);
    return leaf(String(src ?? ""));
  }
}

// ---------------------------------------------------------------- blocks

const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST = /^( {0,12})([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const HTML_DOC = /^\s*(<!doctype html|<html[\s>])/i;

const indentOf = (l) => /^ */.exec(l)[0].length;
const isBlank = (l) => /^\s*$/.test(l);
const isWhitespace = (char) => char !== undefined && /\s/.test(char);

function parseHeading(line) {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  const start = i;
  while (line[i] === "#") i++;
  const level = i - start;
  if (level < 1 || level > 6 || !isWhitespace(line[i])) return null;
  while (isWhitespace(line[i])) i++;

  let end = line.length;
  while (end > i && isWhitespace(line[end - 1])) end--;
  const hashEnd = end;
  while (end > i && line[end - 1] === "#") end--;
  if (end < hashEnd) while (end > i && isWhitespace(line[end - 1])) end--;
  return { level, text: line.slice(i, end) };
}

function fenceOpen(line) {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  const marker = line[i];
  if (marker !== "`" && marker !== "~") return null;
  const start = i;
  while (line[i] === marker) i++;
  const length = i - start;
  if (length < 3) return null;
  while (i < line.length && /\s/.test(line[i])) i++;
  const langStart = i;
  while (i < line.length && /[\w+#.-]/.test(line[i])) i++;
  if (line.includes("`", i)) return null;
  return { marker, length, lang: line.slice(langStart, i) };
}

function fenceClose(line, fence) {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  const start = i;
  while (line[i] === fence.marker) i++;
  if (i - start < fence.length) return false;
  while (i < line.length && /\s/.test(line[i])) i++;
  return i === line.length;
}

function nextNonBlankLine(lines, start) {
  let i = start;
  while (i < lines.length && isBlank(lines[i])) i++;
  return i;
}

function startsBlock(lines, i) {
  const l = lines[i];
  return fenceOpen(l) !== null || parseHeading(l) !== null || HR.test(l) || QUOTE.test(l) || LIST.test(l) || isTableStart(lines, i);
}

function isTableSeparator(line) {
  let i = 0;
  const skipWhitespace = () => {
    while (i < line.length && /\s/.test(line[i])) i++;
  };
  skipWhitespace();
  if (line[i] === "|") {
    i++;
    skipWhitespace();
  }
  let columns = 0;
  while (i < line.length) {
    if (line[i] === ":") i++;
    const start = i;
    while (line[i] === "-") i++;
    if (i - start < 2) return false;
    if (line[i] === ":") i++;
    columns++;
    skipWhitespace();
    if (line[i] !== "|") break;
    i++;
    skipWhitespace();
    if (i === line.length) return columns > 0;
  }
  skipWhitespace();
  return columns > 0 && i === line.length;
}

function isTableStart(lines, i) {
  return lines[i].includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]);
}

function blocks(lines, leaf, depth, options = {}) {
  const out = [];
  if (depth > MAX_DEPTH) return [h("p", null, leaf(lines.join("\n")))];
  let i = 0;
  if (lines.length && HTML_DOC.test(lines.find((l) => !isBlank(l)) ?? "")) return [codeBlock("html", lines.join("\n"), options)];
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (options.blockBudget && options.blockBudget.remaining <= 0) {
      out.push(h("p.md-truncated", null, "Markdown preview truncated because it is too complex."));
      break;
    }
    if (options.blockBudget) options.blockBudget.remaining--;
    let m;
    const fence = fenceOpen(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !fenceClose(lines[i], fence)) body.push(lines[i++]);
      i++; // closing fence (or end)
      out.push(codeBlock(fence.lang, body.join("\n"), options));
      continue;
    }
    const heading = parseHeading(line);
    if (heading) {
      out.push(h(`div.md-h.md-h${heading.level}`, { role: "heading", "aria-level": String(heading.level) }, inline(heading.text, leaf, options)));
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push(h("hr"));
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ""));
      out.push(h("blockquote", null, blocks(body, leaf, depth + 1, options)));
      continue;
    }
    if (isTableStart(lines, i)) {
      const [node, next] = table(lines, i, leaf, options);
      out.push(node);
      i = next;
      continue;
    }
    if (LIST.test(line)) {
      const [node, next] = list(lines, i, leaf, depth, options);
      out.push(node);
      i = next;
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) para.push(lines[i++].trim());
    out.push(h("p", null, inline(para.join("\n"), leaf, options)));
  }
  return out;
}

function skipListRemainder(lines, start, base, ordered) {
  let i = start;
  while (i < lines.length) {
    if (isBlank(lines[i])) {
      const next = nextNonBlankLine(lines, i);
      const match = next < lines.length ? LIST.exec(lines[next]) : null;
      if (match && match[1].length >= base && match[1].length <= base + 3 && /\d/.test(match[2]) === ordered) {
        i = next;
        continue;
      }
      break;
    }
    const match = LIST.exec(lines[i]);
    if (match && match[1].length >= base && match[1].length <= base + 3 && /\d/.test(match[2]) === ordered) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

function list(lines, start, leaf, depth, options) {
  const first = LIST.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const el = ordered ? h("ol", Number.parseInt(first[2], 10) !== 1 ? { start: String(Number.parseInt(first[2], 10)) } : null) : h("ul");
  let i = start;
  while (i < lines.length) {
    if (options.listItemBudget && options.listItemBudget.remaining <= 0) {
      el.append(h("li.md-truncated", null, "List preview truncated because it is too long."));
      i = skipListRemainder(lines, i, base, ordered);
      break;
    }
    if (options.listItemBudget) options.listItemBudget.remaining--;
    const m = LIST.exec(lines[i]);
    if (!m || m[1].length < base || m[1].length > base + 3 || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = m[1].length + m[2].length + 1;
    const content = [m[3] ?? ""];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        const next = nextNonBlankLine(lines, i);
        if (next < lines.length && indentOf(lines[next]) >= contentIndent) {
          while (i < next) {
            content.push("");
            i++;
          }
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind >= contentIndent || (ind > base && LIST.test(l))) {
        content.push(l.slice(Math.min(ind, contentIndent)));
        i++;
        continue;
      }
      if (LIST.test(l) || startsBlock(lines, i)) break;
      content.push(l.trim()); // lazy continuation
      i++;
    }
    let task = null;
    const t = /^\[([ xX])\]\s+/.exec(content[0]);
    if (t) {
      task = h("input", { type: "checkbox", checked: t[1] !== " ", disabled: true, "aria-label": t[1] !== " " ? "done" : "not done" });
      content[0] = content[0].slice(t[0].length);
    }
    const inner = blocks(content, leaf, depth + 1, options);
    // A single short paragraph renders inline (tight list).
    const kids = inner.length === 1 && inner[0].tagName === "P" ? [...inner[0].childNodes] : inner;
    el.append(h(`li${task ? ".task" : ""}`, null, task, kids));
    while (i < lines.length && isBlank(lines[i])) {
      const next = nextNonBlankLine(lines, i);
      const nm = next < lines.length ? LIST.exec(lines[next]) : null;
      if (nm && nm[1].length >= base && nm[1].length <= base + 3 && /\d/.test(nm[2]) === ordered) i = next;
      else break;
    }
  }
  return [el, i];
}

const MAX_TABLE_COLUMNS = 64;
const MAX_TABLE_CELLS = 1024;

function splitRow(line, maxColumns = Infinity) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  let code = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (c === "`") {
      code = !code;
      cur += c;
    } else if (c === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
      if (cells.length === maxColumns && k < s.length - 1) return { cells, truncated: true };
    } else cur += c;
  }
  cells.push(cur.trim());
  return { cells, truncated: false };
}

function skipTableRows(lines, start) {
  let i = start;
  while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) i++;
  return i;
}

function table(lines, start, leaf, options) {
  const budget = options.tableCellBudget;
  const maxColumns = budget ? MAX_TABLE_COLUMNS : Infinity;
  const header = splitRow(lines[start], maxColumns);
  const availableColumns = budget ? Math.min(MAX_TABLE_COLUMNS, budget.remaining) : header.cells.length;
  const head = header.cells.slice(0, availableColumns);
  const columnsTruncated = head.length < header.cells.length;
  if (budget) budget.remaining -= head.length;
  const separator = splitRow(lines[start + 1], maxColumns);
  const aligns = separator.cells.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : null));
  if (head.length === 0) {
    return [h("p.md-truncated", null, "Table preview truncated because it is too large."), skipTableRows(lines, start + 2)];
  }
  const cell = (tag, text, k) => h(tag, aligns[k] ? { class: `align-${aligns[k]}` } : null, inline(text, leaf, options));
  const thead = h("thead", null, h("tr", null, head.map((c, k) => cell("th", c, k))));
  const rows = [];
  let truncated = header.truncated || separator.truncated || columnsTruncated;
  let i = start + 2;
  while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
    if (budget && budget.remaining < head.length) {
      truncated = true;
      i = skipTableRows(lines, i);
      break;
    }
    const row = splitRow(lines[i++], maxColumns);
    truncated ||= row.truncated;
    if (budget) budget.remaining -= head.length;
    rows.push(h("tr", null, head.map((_, k) => cell("td", row.cells[k] ?? "", k))));
  }
  const renderedTable = h("table", null, thead, h("tbody", null, rows));
  return [
    h("div.md-table", null, renderedTable, truncated ? h("p.md-truncated", null, "Table preview truncated because it is too large.") : null),
    i,
  ];
}

function codeBlock(lang, code, options = {}) {
  const l = (lang || "").toLowerCase();
  const pre = h("pre", null, h("code", l ? { "data-lang": l } : null, code));
  const copy = h("button.md-code-btn", { type: "button", title: "Copy code" }, icon("copy", 13), " Copy");
  copy.addEventListener("click", async () => {
    copy.lastChild.textContent = (await copyText(code)) ? " Copied" : " Copy failed";
    setTimeout(() => (copy.lastChild.textContent = " Copy"), 1500);
  });
  const bar = h("div.md-code-bar", null, h("span.md-code-lang", null, l || "code"), h("span.spacer"));
  const box = h("div.md-code", null, bar, pre);
  if (options.htmlPreview !== false && (l === "html" || l === "svg" || l === "xml" && /<svg[\s>]/i.test(code))) {
    let frame = null;
    const toggle = h("button.md-code-btn", { type: "button", title: "Render this HTML in a sandbox (no scripts)" }, icon("eye", 13), " Preview");
    toggle.addEventListener("click", () => {
      if (frame) {
        frame.remove();
        frame = null;
        pre.hidden = false;
        toggle.lastChild.textContent = " Preview";
        return;
      }
      frame = htmlFrame(l === "html" ? code : `<!doctype html><meta charset="utf-8"><body style="margin:0">${code}</body>`);
      pre.hidden = true;
      box.append(frame);
      toggle.lastChild.textContent = " Source";
    });
    bar.append(toggle);
  }
  bar.append(copy);
  return box;
}

/** Sandboxed preview: no allow-scripts and no allow-same-origin, so it can't run code or reach the app. */
function htmlFrame(html) {
  const f = document.createElement("iframe");
  f.className = "md-html-frame";
  f.setAttribute("sandbox", "");
  f.setAttribute("referrerpolicy", "no-referrer");
  f.setAttribute("loading", "lazy");
  f.setAttribute("title", "HTML preview (sandboxed)");
  f.srcdoc = html;
  return f;
}

// ---------------------------------------------------------------- inline

const URL_AT = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}*_~]/y;
const MAX_INLINE_MARKERS = 64;
const INLINE_MARKERS = new Set(["[", "!", "*", "_", "~", "<", "`"]);

function safeHref(raw) {
  try {
    const u = new URL(raw.replace(/^<|>$/g, ""));
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

function linkNode(href, children, title) {
  const safe = safeHref(href);
  if (!safe) return h("span", null, children);
  return h("a", { href: safe, target: "_blank", rel: "noopener noreferrer", title: title || safe }, children);
}

function hasExcessiveInlineMarkers(text, options) {
  let markers = 0;
  for (const c of text) {
    if (!INLINE_MARKERS.has(c)) continue;
    markers++;
    if (markers > MAX_INLINE_MARKERS) return true;
    if (options.inlineMarkerBudget && markers > options.inlineMarkerBudget.remaining) return true;
    if (text.length > MAX_COMPLEX_INLINE_LENGTH && markers > MAX_COMPLEX_INLINE_MARKERS) return true;
  }
  if (options.inlineMarkerBudget) options.inlineMarkerBudget.remaining -= markers;
  return false;
}

function backtickRunsByLength(text) {
  const runs = new Map();
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    const start = i++;
    while (text[i] === "`") i++;
    const length = i - start;
    let positions = runs.get(length);
    if (!positions) runs.set(length, (positions = []));
    positions.push(start);
  }
  return runs;
}

function codeSpanAt(text, start, runs) {
  let openEnd = start + 1;
  while (text[openEnd] === "`") openEnd++;
  const length = openEnd - start;
  const positions = runs.get(length);
  if (!positions) return { openEnd, content: null };

  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (positions[middle] <= openEnd) low = middle + 1;
    else high = middle;
  }
  if (low === positions.length) return { openEnd, content: null };

  const closeStart = positions[low];
  return { openEnd: closeStart + length, content: text.slice(openEnd, closeStart) };
}

/** Inline Markdown → nodes. `leaf` renders runs of plain text. */
export function inline(text, leaf = plainLeaf, options = {}) {
  if (options.preview && hasExcessiveInlineMarkers(text, options)) {
    if (options.inlineFallback) options.inlineFallback.used = true;
    return leaf(text);
  }
  const out = [];
  const backtickRuns = backtickRunsByLength(text);
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) out.push(...leaf(buf));
    buf = "";
  };
  const at = (re) => {
    re.lastIndex = i;
    return re.exec(text);
  };
  while (i < text.length) {
    const c = text[i];
    const prev = i > 0 ? text[i - 1] : " ";
    let m;
    if (c === "\\" && /[\\`*_~[\]()#+\-.!|>{}]/.test(text[i + 1] ?? "")) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "h" && !/\w/.test(prev) && (m = at(URL_AT))) {
      buf += m[0]; // leaf() linkifies it; keeps * and _ inside URLs from becoming emphasis
      i += m[0].length;
      continue;
    }
    if (c === "`") {
      const span = codeSpanAt(text, i, backtickRuns);
      if (span.content !== null) {
        flush();
        const code = span.content.replace(/\n/g, " ");
        out.push(h("code", null, /^ .* $/.test(code) ? code.slice(1, -1) : code));
      } else {
        buf += text.slice(i, span.openEnd);
      }
      i = span.openEnd;
      continue;
    }
    if (c === "!" && (m = at(/!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"([^"\n]*)")?\s*\)/y))) {
      flush();
      out.push(linkNode(m[2], [icon("image", 13), ` ${m[1] || "image"}`], m[3]));
      i += m[0].length;
      continue;
    }
    if (c === "[" && (m = at(/\[((?:[^[\]\n]|\[[^\]\n]*\])+)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"([^"\n]*)")?\s*\)/y))) {
      flush();
      out.push(linkNode(m[2], inline(m[1], plainLeaf, options), m[3])); // no nested links: plain leaf inside
      i += m[0].length;
      continue;
    }
    if (c === "<" && (m = at(/<(https?:\/\/[^\s<>]+)>/y))) {
      flush();
      out.push(linkNode(m[1], [m[1]]));
      i += m[0].length;
      continue;
    }
    if ((c === "*" || c === "_") && text[i + 1] === c) {
      m = c === "*" ? at(/\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/y) : !/\w/.test(prev) ? at(/__(?=\S)([\s\S]*?\S)__(?!\w)/y) : null;
      if (m) {
        flush();
        out.push(h("strong", null, inline(m[1], leaf, options)));
        i += m[0].length;
        continue;
      }
    }
    if (c === "~" && text[i + 1] === "~" && (m = at(/~~(?=\S)([\s\S]*?\S)~~/y))) {
      flush();
      out.push(h("del", null, inline(m[1], leaf, options)));
      i += m[0].length;
      continue;
    }
    if (c === "*" || (c === "_" && !/\w/.test(prev))) {
      m = c === "*" ? at(/\*(?=[^\s*])((?:\*\*[\s\S]*?\*\*|[^*])*?[^\s*])\*(?!\*)/y) : at(/_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/y);
      if (m) {
        flush();
        out.push(h("em", null, inline(m[1], leaf, options)));
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}
