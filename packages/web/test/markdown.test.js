import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";

const markdownUrl = new URL("../public/md.js", import.meta.url).href;

test("Markdown rendering handles long blank runs and unmatched code delimiters", () => {
  const script = `
    class MockNode {
      constructor(name) { this.tagName = name.toUpperCase(); this.childNodes = []; }
      append(...nodes) { this.childNodes.push(...nodes); }
      addEventListener() {}
      setAttribute() {}
    }
    globalThis.Node = MockNode;
    globalThis.document = {
      createElement: (name) => new MockNode(name),
      createTextNode: (value) => Object.assign(new MockNode("#text"), { value: String(value) }),
    };
    const { inline, markdown } = await import(${JSON.stringify(markdownUrl)});
    const betweenItems = markdown("- first\\n" + "\\n".repeat(100_000) + "- second", undefined, { htmlPreview: false });
    const withinItem = markdown("- parent\\n" + "  \\n".repeat(100_000) + "  - nested", undefined, { htmlPreview: false });
    const unmatchedTicks = markdown("x" + String.fromCharCode(96).repeat(200_000), undefined, { htmlPreview: false });
    const unmatchedBrackets = markdown("[a".repeat(100_000), undefined, { htmlPreview: false });
    const pathologicalEmphasis = markdown("*a" + "**a".repeat(40), undefined, { htmlPreview: false });
    const wideTable = markdown("|".repeat(201) + "\\n--|--\\n" + "|x\\n".repeat(200), undefined, { htmlPreview: false });
    const manyLines = markdown("- item\\n".repeat(3_000), undefined, { htmlPreview: false });
    const manyBlocks = markdown("paragraph\\n\\n".repeat(3_000), undefined, { htmlPreview: false });
    const malformedFenceSource = String.fromCharCode(96).repeat(3) + " ".repeat(200_000) + String.fromCharCode(96);
    const malformedFence = markdown(malformedFenceSource, undefined, { htmlPreview: false });
    const tableSource = "|" + Array(64).fill("h").join("|") + "|\\n|" + Array(64).fill("--").join("|") + "|\\n|x|\\n\\n";
    const repeatedTables = markdown(tableSource.repeat(500), undefined, { htmlPreview: false });
    const malformedTableSource = "| header |\\n" + " ".repeat(200_000) + "x";
    const malformedTable = markdown(malformedTableSource, undefined, { htmlPreview: false });
    const longHeadingSource = "# a" + " ".repeat(200_000) + "x";
    const longHeading = markdown(longHeadingSource, undefined, { htmlPreview: false });
    const longEmphasisSource = "*a" + "**a".repeat(31) + " ".repeat(200_000) + "x";
    const longEmphasis = markdown(longEmphasisSource, undefined, { htmlPreview: false });
    const mediumEmphasisSource = "*a" + "**a".repeat(15) + " ".repeat(200_000) + "x";
    const mediumEmphasis = markdown(mediumEmphasisSource, undefined, { htmlPreview: false });
    const ordinaryMessages = markdown("**bold** ".repeat(13));
    const partialMultiTickInput = String.fromCharCode(96).repeat(2) + "x" + String.fromCharCode(96);
    const partialMultiTickMessage = markdown(partialMultiTickInput);
    const partialMultiTickPreview = markdown(partialMultiTickInput, undefined, { htmlPreview: false });
    const ordinaryPreview = markdown("**bold** ".repeat(13), undefined, { htmlPreview: false });
    const ordinaryLongPreview = markdown("This is a normal paragraph with **one**, **two**, and **three** emphasized phrases. Additional explanatory text makes the paragraph longer than 128 characters.", undefined, { htmlPreview: false });
    const ordinaryFivePhrasePreview = markdown("A normal report describes **one**, **two**, **three**, **four**, and **five** key findings, followed by a brief explanation of the results and the actions needed next.", undefined, { htmlPreview: false });
    const formattedPreviewBlocks = markdown(Array(5).fill("**bold** ".repeat(13)).join("\\n\\n"), undefined, { htmlPreview: false });
    if (betweenItems.length !== 1 || betweenItems[0].tagName !== "UL" || betweenItems[0].childNodes.length !== 2) {
      throw new Error("expected both list items to render");
    }
    if (withinItem.length !== 1 || withinItem[0].tagName !== "UL") throw new Error("expected nested list to render");
    const parentItem = withinItem[0].childNodes[0];
    const nestedList = parentItem?.childNodes.find((node) => node.tagName === "UL");
    if (nestedList?.childNodes[0]?.tagName !== "LI") throw new Error("expected nested list item to render");
    if (unmatchedTicks.length !== 2 || !unmatchedTicks[1].childNodes.map((child) => child.value).join("").includes("Some inline Markdown was shown as text")) {
      throw new Error("complex preview inline syntax should be marked as literal text");
    }
    const tick = String.fromCharCode(96);
    if (unmatchedBrackets[0].childNodes.map((child) => child.value).join("") !== "[a".repeat(100_000)) {
      throw new Error("unmatched brackets should remain unchanged");
    }
    if (pathologicalEmphasis[0].childNodes.map((child) => child.value).join("") !== "*a" + "**a".repeat(40)) {
      throw new Error("complex emphasis syntax should remain literal");
    }
    const countNodes = (node) => 1 + (node.childNodes ?? []).reduce((total, child) => total + countNodes(child), 0);
    const tableText = (node) => node.value ?? (node.childNodes ?? []).map(tableText).join("");
    if (countNodes(wideTable[0]) > 5000 || !tableText(wideTable[0]).includes("Table preview truncated")) {
      throw new Error("wide Markdown table should be bounded and marked truncated");
    }
    if (manyLines.reduce((count, node) => count + countNodes(node), 0) > 5000 || !manyLines.map(tableText).join("").includes("List preview truncated")) {
      throw new Error("long Markdown list should be bounded and marked truncated");
    }
    if (manyBlocks.reduce((count, node) => count + countNodes(node), 0) > 5000 || !manyBlocks.map(tableText).join("").includes("too complex")) {
      throw new Error("many Markdown blocks should be bounded and marked truncated");
    }
    if (malformedFence[0].childNodes.map((child) => child.value).join("") !== malformedFenceSource) {
      throw new Error("malformed fence should remain literal text");
    }
    if (repeatedTables.reduce((count, node) => count + countNodes(node), 0) > 10_000 || !repeatedTables.map(tableText).join("").includes("Table preview truncated")) {
      throw new Error("tables should share a document-wide cell budget");
    }
    if (malformedTable.length !== 1 || malformedTable[0].tagName !== "P" || !tableText(malformedTable[0]).includes("x")) {
      throw new Error("malformed table separators should remain plain text");
    }
    if (longHeading.length !== 1 || !longHeading[0].className.includes("md-h1") || !tableText(longHeading[0]).endsWith("x")) {
      throw new Error("long heading whitespace should parse without backtracking");
    }
    if (longEmphasis.length !== 2 || tableText(longEmphasis[0]) !== longEmphasisSource || !tableText(longEmphasis[1]).includes("shown as text")) {
      throw new Error("complex long inline syntax should be shown literally with a fallback notice");
    }
    if (mediumEmphasis.length !== 2 || tableText(mediumEmphasis[0]) !== mediumEmphasisSource || !tableText(mediumEmphasis[1]).includes("shown as text")) {
      throw new Error("ambiguous long inline syntax should be bounded before emphasis matching");
    }
    if (ordinaryMessages[0].childNodes.filter((node) => node.tagName === "STRONG").length !== 13) {
      throw new Error("ordinary messages should retain inline formatting");
    }
    const partialMultiTickChildren = partialMultiTickMessage[0]?.childNodes ?? [];
    if (partialMultiTickChildren[0]?.value !== String.fromCharCode(96) || partialMultiTickChildren[1]?.tagName !== "CODE" || partialMultiTickChildren[1]?.childNodes[0]?.value !== "x") {
      throw new Error("unmatched multi-backtick runs should retain legacy single-backtick spans in messages");
    }
    if (tableText(partialMultiTickPreview[0]) !== partialMultiTickInput || partialMultiTickPreview[0]?.childNodes.some((node) => node.tagName === "CODE")) {
      throw new Error("unmatched multi-backtick runs should remain literal in transfer previews");
    }
    if (ordinaryPreview[0].childNodes.filter((node) => node.tagName === "STRONG").length !== 13 || ordinaryPreview.length !== 1) {
      throw new Error("ordinary preview content should retain inline formatting without a fallback notice");
    }
    if (ordinaryLongPreview.length !== 1 || ordinaryLongPreview[0].childNodes.filter((child) => child.tagName === "STRONG").length !== 3) {
      throw new Error("ordinary long preview paragraphs should retain their emphasis formatting");
    }
    if (ordinaryFivePhrasePreview.length !== 1 || ordinaryFivePhrasePreview[0].childNodes.filter((child) => child.tagName === "STRONG").length !== 5) {
      throw new Error("ordinary five-phrase preview paragraphs should retain their emphasis formatting");
    }
    if (formattedPreviewBlocks.length !== 5 || formattedPreviewBlocks.some((node) => node.childNodes.filter((child) => child.tagName === "STRONG").length !== 13)) {
      throw new Error("ordinary preview blocks should retain common inline formatting without premature fallback");
    }
    if (unmatchedTicks[0].childNodes.map((child) => child.value).join("") !== "x" + tick.repeat(200_000)) {
      throw new Error("unmatched backticks should remain unchanged");
    }
    const codeNodes = inline(tick + "one" + tick + " and " + tick.repeat(2) + "two " + tick + "ticks" + tick.repeat(2));
    const fallbackState = { used: false };
    const manyCodeSpans = inline((tick + "x" + tick).repeat(1_000), undefined, { preview: true, inlineFallback: fallbackState });
    if (!fallbackState.used || manyCodeSpans.length !== 1 || manyCodeSpans[0].value !== (tick + "x" + tick).repeat(1_000)) {
      throw new Error("too many code spans should remain bounded literal text in a preview");
    }
    const codeText = codeNodes.filter((node) => node.tagName === "CODE").map((node) => node.childNodes.map((child) => child.value).join(""));
    if (JSON.stringify(codeText) !== JSON.stringify(["one", "two " + String.fromCharCode(96) + "ticks"])) throw new Error("expected variable-length code spans to render");
    const ordinaryInline = inline("[site](https://example.com) **bold**");
    if (!ordinaryInline.some((node) => node.tagName === "A") || !ordinaryInline.some((node) => node.tagName === "STRONG")) {
      throw new Error("expected ordinary links and emphasis to render");
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 5000 });

  assert.equal(result.error, undefined, `Markdown renderer exceeded its time bound: ${result.error?.message}`);
  assert.equal(result.status, 0, `Markdown renderer failed: ${result.stderr}`);
});
