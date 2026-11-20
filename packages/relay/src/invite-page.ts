import { createHash } from "node:crypto";

/** Channel id in an invite path: 16 bytes as unpadded base64url. */
export const INVITE_PATH_RE = /^\/i\/([A-Za-z0-9_-]{22})\/?$/;

// The page is identical for every channel: it never interpolates request data, and it reads the
// link (including the #fragment) only from location.href inside the browser. The fragment is never
// sent anywhere: there is no fetch, no form, and connect-src is 'none'.
const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--border:#ddd;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ececea;--muted:#9a9a94;--card:#21211f;--border:#3a3a37;--accent:#7f9cf5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:36rem;margin:0 auto;padding:3rem 16px}
h1{font-size:1.4rem;margin:0 0 1rem}
p{margin:0 0 1rem}
.muted{color:var(--muted);font-size:.9rem}
.box{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px;display:flex;gap:8px;align-items:center}
code{flex:1;min-width:0;overflow-wrap:anywhere;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
button{flex:none;font:inherit;padding:6px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
`.trim();

const SCRIPT = `
(function(){
  var link = document.getElementById("link");
  var btn = document.getElementById("copy");
  link.textContent = location.href;
  btn.addEventListener("click", function(){
    var done = function(){ btn.textContent = "Copied"; setTimeout(function(){ btn.textContent = "Copy"; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(location.href).then(done, function(){ select(); });
    } else { select(); }
  });
  function select(){ var r = document.createRange(); r.selectNodeContents(link); var s = getSelection(); s.removeAllRanges(); s.addRange(r); }
})();
`.trim();

const sha = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

export const INVITE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex,nofollow">
<title>Spencer invite</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>This is a Spencer invite</h1>
<p>Paste the whole link (including the part after <code>#</code>) into your Spencer's web UI &rarr; <strong>Join</strong>.</p>
<div class="box"><code id="link"></code><button id="copy" type="button">Copy</button></div>
<p class="muted">The secret part of the link after <code>#</code> stays in your browser. It is never sent to this server.</p>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

export const INVITE_PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": [
    "default-src 'none'",
    `script-src ${sha(SCRIPT)}`,
    `style-src ${sha(STYLE)}`,
    "connect-src 'none'",
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cache-control": "public, max-age=300",
};
