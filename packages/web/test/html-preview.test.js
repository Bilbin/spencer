import { test } from "node:test";
import assert from "node:assert/strict";
import { staticHtmlPreviewDocument } from "../public/html-preview.js";

test("HTML previews retain self-contained styles and static report structure only", () => {
  const css = `@import url("http://127.0.0.1:9/blocked.css");\n:root { --report-ink: #16324f; }\n.report { color: var(--report-ink); background: #f4f7fa; }\n.cell { border-color: #567; }`;
  const source = `<!doctype html><html lang="en"><head><title>Quarterly</title><link rel="stylesheet" href="http://127.0.0.1:9/report.css"><style media="screen" title="Report">${css}</style><style media="print">body{display:none}</style></head><body style="font-family: serif; color: #16324f"><article id="report" class="report" style="max-width: 64rem; margin: auto"><h1>Quarterly report</h1><p>Summary <strong>ready</strong></p><table><thead><tr><th class="cell" colspan="2">Metric</th></tr></thead><tbody><tr><td>Count</td><td>8</td></tr></tbody></table><a href="http://127.0.0.1:9/out">External link</a><img src="http://127.0.0.1:9/pixel.png"><iframe src="http://127.0.0.1:9/frame"></iframe><form action="http://127.0.0.1:9/submit"><button>Submit</button></form><script>parent.document.body.dataset.compromised = "yes"</script></article></body></html>`;
  const document = staticHtmlPreviewDocument(source);

  assert.ok(document.includes(css), "embedded stylesheet text survives");
  assert.ok(document.includes('<style media="screen" title="Report">'), "screen stylesheet metadata survives");
  assert.ok(document.includes("<style media=\"print\">body{display:none}</style>"), "print-only rules remain print-only");
  assert.match(document, /<html lang="en">/);
  assert.match(document, /<body style="font-family: serif; color: #16324f">/);
  assert.match(document, /style="max-width: 64rem; margin: auto"/, "inline presentation styles survive");
  assert.match(document, /<table>[\s\S]*<th class="cell" colspan="2">Metric<\/th>[\s\S]*<td>8<\/td>[\s\S]*<\/table>/, "report tables and cells survive");
  assert.match(document, /Quarterly report[\s\S]*Summary <strong>ready<\/strong>[\s\S]*External link/, "static text and formatting survive");
  assert.match(document, /default-src 'none'; script-src 'none';[\s\S]*connect-src 'none'[\s\S]*form-action 'none'/, "the child document denies active and network capabilities");
  assert.doesNotMatch(document, /<\/?(?:script|iframe|img|form|button|link)\b/i, "active/resource elements are not serialized");
  assert.doesNotMatch(document, /\b(?:href|src|action|formaction|target)\s*=/i, "URL and submission attributes are not serialized");
  assert.doesNotMatch(document, /compromised/, "script payload text is discarded");
});

test("HTML forms preserve static descendants while removing controls and submission behavior", () => {
  const output = staticHtmlPreviewDocument(`<form action="https://example.invalid/submit" method="post"><h1>Invoice</h1><p>Total: $150</p><table><tr><th>Item</th><td>Consulting</td></tr></table><input name="token" value="secret"><button>Pay now</button><textarea>draft</textarea><select><option>Choose</option></select></form><p>Footer</p>`);

  assert.match(output, /<h1>Invoice<\/h1><p>Total: \$150<\/p>/);
  assert.match(output, /<table>[\s\S]*<th>Item<\/th><td>Consulting<\/td>[\s\S]*<\/table>/);
  assert.match(output, /<p>Footer<\/p>/);
  assert.doesNotMatch(output, /<\/?(?:form|input|button|textarea|select|option)\b/i);
  assert.doesNotMatch(output, /(?:action|method|formaction)\s*=/i);
  assert.doesNotMatch(output, /Pay now|draft|Choose|secret/);
});

test("HTML previews retain safe content through nested or unclosed forms without exposing dropped subtrees", () => {
  const source = `<form action="https://example.invalid/outer"><h2>Outer heading</h2><form method="post"><p>Nested total: $25</p><script>discard this script</script><object>discard object contents</object><textarea>discard control contents</textarea><p>After removed content</p>`;
  const output = staticHtmlPreviewDocument(source);

  assert.match(output, /<h2>Outer heading<\/h2>[\s\S]*<p>Nested total: \$25<\/p>/);
  assert.match(output, /<p>After removed content<\/p>/);
  assert.doesNotMatch(output, /<\/?form\b|\b(?:action|method)\s*=|<\/?(?:script|object|textarea)\b/i);
  assert.doesNotMatch(output, /discard this script|discard object contents|discard control contents/);
});

test("HTML previews preserve following content after Unicode before raw-text tags", () => {
  const styled = staticHtmlPreviewDocument("<p>İ</p><style>p{color:red}</style><p>AFTER</p>");
  const scripted = staticHtmlPreviewDocument("<p>İ</p><script>discarded</script><p>AFTER</p>");

  assert.match(styled, /<style>p\{color:red\}<\/style>/);
  assert.match(styled, /<body><p>İ<\/p><p>AFTER<\/p><\/body>/);
  assert.match(scripted, /<body><p>İ<\/p><p>AFTER<\/p><\/body>/);
  assert.doesNotMatch(scripted, /discarded|<script/i);
});

test("HTML preview parser bounds nesting and continues after void controls", () => {
  const nested = `${"<div>".repeat(70)}deep${"</div>".repeat(70)}`;
  const output = staticHtmlPreviewDocument(`<input><p>Still visible</p>${nested}`);

  assert.match(output, /<p>Still visible<\/p>/);
  assert.match(output, /Preview truncated because the document is too complex/);
  assert.ok((output.match(/<div>/g) ?? []).length <= 64, "generated markup respects the nesting limit");

  const selfClosing = staticHtmlPreviewDocument(`${"<div/>".repeat(70)}<p>Too deep</p>`);
  assert.match(selfClosing, /Preview truncated because the document is too complex/);
  assert.ok((selfClosing.match(/<div>/g) ?? []).length <= 64, "HTML self-closing syntax cannot bypass the nesting limit");
});
