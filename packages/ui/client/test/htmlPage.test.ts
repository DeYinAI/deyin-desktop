import assert from "node:assert/strict";
import test from "node:test";
import {
  extractHtmlPageFromMarkdown,
  extractHtmlPageFromMarkdownLoose,
  isFullHtmlDocument,
  titleFromHtml,
} from "../src/htmlPage.js";

const SAMPLE = `<!DOCTYPE html>
<html><head><title>Demo</title></head><body><h1>Hello</h1></body></html>`;

test("isFullHtmlDocument: accepts doctype pages", () => {
  assert.equal(isFullHtmlDocument(SAMPLE), true);
});

test("isFullHtmlDocument: rejects tiny snippets", () => {
  assert.equal(isFullHtmlDocument("<div>hi</div>"), false);
});

test("extractHtmlPageFromMarkdown: reads ```html fences", () => {
  const text = `Here:\n\`\`\`html\n${SAMPLE}\n\`\`\``;
  assert.equal(extractHtmlPageFromMarkdown(text), SAMPLE);
});

test("extractHtmlPageFromMarkdownLoose: finds full pages in untagged fences", () => {
  const text = `\`\`\`\n${SAMPLE}\n\`\`\``;
  assert.equal(extractHtmlPageFromMarkdownLoose(text), SAMPLE);
});

test("titleFromHtml: parses document title", () => {
  assert.equal(titleFromHtml(SAMPLE), "Demo");
});
