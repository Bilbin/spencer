// Incoming HTML is serialized as a static document inside an opaque-origin sandboxed iframe.
// Never attach untrusted style elements or attributes to the host document.
const STATIC_TAGS = new Set("a abbr article aside b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i ins kbd li main mark nav ol p pre q s section small span strong sub summary sup table tbody td tfoot th thead tr u ul var".split(" "));
const VOID_TAGS = new Set(["br", "col", "hr"]);
const DROP_CONTENT = new Set("applet audio button canvas embed form frame frameset iframe input math noscript object option portal script select svg template textarea title video".split(" "));
const DROP_VOID_CONTENT = new Set(["embed", "frame", "input"]);
const SAFE_ATTRIBUTES = new Set("abbr align border cellpadding cellspacing class colspan datetime dir headers height hidden id lang open rowspan role scope start style title valign value width".split(" "));
const STYLE_ATTRIBUTES = new Set(["disabled", "media", "title", "type"]);
const MAX_HTML_NESTING = 64;
const MAX_HTML_NODES = 20_000;
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; style-src-attr 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'";
const BASE_STYLES = `:root{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light dark}*{box-sizing:border-box}html{min-height:100%;overflow-wrap:anywhere}body{margin:0;padding:clamp(16px,4vw,40px);color:CanvasText;background:Canvas}pre,code,kbd{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}pre{max-width:100%;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}table{max-width:100%;border-collapse:collapse}th,td{padding:.4em .65em;border:1px solid color-mix(in srgb,CanvasText 24%,transparent);text-align:start}img,video,iframe,object,embed{display:none!important}`;

function escapeText(text) {
  // Preserve HTML character references for the iframe's parser, but never let raw text become markup.
  return text.replace(/</g, "&lt;");
}

function escapeAttribute(value) {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function tagEnd(source, start) {
  let quote = "";
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "\"" || c === "'") quote = c;
    else if (c === ">") return i + 1;
  }
  return source.length;
}

function readTag(source, start) {
  let i = start + 1;
  const closing = source[i] === "/";
  if (closing) i++;
  const nameStart = i;
  while (i < source.length && /[a-z0-9:-]/i.test(source[i])) i++;
  const name = source.slice(nameStart, i).toLowerCase();
  if (!name || !/[a-z]/.test(name[0])) return null;
  const end = tagEnd(source, i);
  return { name, closing, attrStart: i, attrEnd: Math.max(i, end - 1), end };
}

function readAttributes(source, start, end, allowed = SAFE_ATTRIBUTES) {
  const attrs = [];
  let i = start;
  while (i < end) {
    while (i < end && (/[\s/]/.test(source[i]))) i++;
    const nameStart = i;
    while (i < end && !/[\s=/>]/.test(source[i])) i++;
    if (i === nameStart) {
      i++;
      continue;
    }
    const name = source.slice(nameStart, i).toLowerCase();
    while (i < end && /\s/.test(source[i])) i++;
    let value = "";
    if (source[i] === "=") {
      i++;
      while (i < end && /\s/.test(source[i])) i++;
      const quote = source[i] === "\"" || source[i] === "'" ? source[i++] : "";
      const valueStart = i;
      if (quote) {
        while (i < end && source[i] !== quote) i++;
        value = source.slice(valueStart, i);
        if (source[i] === quote) i++;
      } else {
        while (i < end && !/[\s>]/.test(source[i])) i++;
        value = source.slice(valueStart, i);
      }
    }
    if (allowed.has(name) || (allowed === SAFE_ATTRIBUTES && (name.startsWith("aria-") || name.startsWith("data-")))) {
      attrs.push(`${name}="${escapeAttribute(value)}"`);
    }
  }
  return attrs.length ? ` ${attrs.join(" ")}` : "";
}

function findClosingTag(source, name, from) {
  const marker = `</${name}`;
  let start = source.indexOf("</", from);
  while (start >= 0) {
    let matches = true;
    for (let i = 0; i < marker.length; i++) {
      let c = source[start + i];
      if (c >= "A" && c <= "Z") c = String.fromCharCode(c.charCodeAt(0) + 32);
      if (c !== marker[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      const boundary = source[start + marker.length];
      if (boundary === ">" || boundary === "/" || boundary === undefined || /\s/.test(boundary)) {
        return { start, end: tagEnd(source, start + 2 + name.length) };
      }
    }
    start = source.indexOf("</", start + 2);
  }
  return null;
}

function escapeStyleText(css) {
  // A style element is HTML raw text. CSS-escape any closing-tag prefix before serializing it.
  return css.replace(/<\/style(?=[\s/>]|$)/gi, "\\3c /style");
}

/** Return a self-contained, static HTML document suitable only for a sandboxed iframe's srcdoc. */
export function staticHtmlPreviewDocument(source) {
  source = String(source ?? "");
  const output = [];
  const styles = [];
  const stack = [];
  let htmlAttributes = "";
  let bodyAttributes = "";
  let pos = 0;
  let nodes = 0;
  let truncated = false;

  while (pos < source.length) {
    if (source.startsWith("<!--", pos)) {
      const end = source.indexOf("-->", pos + 4);
      pos = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<!", pos) || source.startsWith("<?", pos)) {
      pos = tagEnd(source, pos + 2);
      continue;
    }
    if (source[pos] === "<") {
      const tag = readTag(source, pos);
      if (tag) {
        pos = tag.end;
        if (tag.name === "style" && !tag.closing) {
          const close = findClosingTag(source, "style", pos);
          const css = source.slice(pos, close?.start ?? source.length);
          if (css) {
            if (nodes >= MAX_HTML_NODES) {
              truncated = true;
              break;
            }
            styles.push({ attributes: readAttributes(source, tag.attrStart, tag.attrEnd, STYLE_ATTRIBUTES), css: escapeStyleText(css) });
            nodes++;
          }
          pos = close?.end ?? source.length;
          continue;
        }
        if (DROP_CONTENT.has(tag.name) && !tag.closing) {
          if (DROP_VOID_CONTENT.has(tag.name)) continue;
          const close = findClosingTag(source, tag.name, pos);
          pos = close?.end ?? source.length;
          continue;
        }
        if (tag.name === "html" || tag.name === "body") {
          if (!tag.closing) {
            const attributes = readAttributes(source, tag.attrStart, tag.attrEnd);
            if (tag.name === "html" && !htmlAttributes) htmlAttributes = attributes;
            if (tag.name === "body" && !bodyAttributes) bodyAttributes = attributes;
          }
          continue;
        }
        if (tag.name === "head") continue;
        if (!STATIC_TAGS.has(tag.name)) continue;
        if (tag.closing) {
          const index = stack.lastIndexOf(tag.name);
          if (index >= 0) {
            for (let k = stack.length - 1; k >= index; k--) output.push(`</${stack[k]}>`);
            stack.length = index;
          }
          continue;
        }
        if (nodes >= MAX_HTML_NODES || (!VOID_TAGS.has(tag.name) && stack.length >= MAX_HTML_NESTING)) {
          truncated = true;
          break;
        }
        output.push(`<${tag.name}${readAttributes(source, tag.attrStart, tag.attrEnd)}>`);
        nodes++;
        if (!VOID_TAGS.has(tag.name)) stack.push(tag.name);
        continue;
      }
    }
    const next = source.indexOf("<", pos + 1);
    const end = next < 0 ? source.length : next;
    const text = source.slice(pos, end);
    if (text) {
      if (nodes >= MAX_HTML_NODES) {
        truncated = true;
        break;
      }
      output.push(escapeText(text));
      nodes++;
    }
    pos = end;
  }

  if (truncated) output.push("<p>Preview truncated because the document is too complex.</p>");
  while (stack.length) output.push(`</${stack.pop()}>`);
  const embeddedStyles = styles.map(({ attributes, css }) => `<style${attributes}>${css}</style>`).join("");
  return `<!doctype html><html${htmlAttributes}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${BASE_STYLES}</style>${embeddedStyles}</head><body${bodyAttributes}>${output.join("")}</body></html>`;
}

export function htmlPreviewFrame(source, title) {
  const frame = document.createElement("iframe");
  frame.className = "html-preview-frame";
  frame.setAttribute("sandbox", "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", `HTML preview of ${title}`);
  frame.srcdoc = staticHtmlPreviewDocument(source);
  return frame;
}
