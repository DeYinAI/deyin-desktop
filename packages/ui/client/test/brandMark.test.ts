import assert from "node:assert/strict";
import test from "node:test";
import { markFor } from "../src/components/BrandMark.js";

test("markFor resolves Datadog logo and color tints", () => {
  const mark = markFor("datadog");
  assert.ok(mark);
  assert.equal(mark.kind, "brand");
  assert.equal(mark.brand.title, "Datadog");
  assert.equal(mark.brand.hex, "#632CA6");
  assert.ok(mark.brand.path.length > 50);
  assert.ok(mark.brand.colored);
  assert.equal(mark.brand.colored.viewBox, "0 0 24 24");
});

test("markFor resolves GitLab logo with colored Tanuki art and tints", () => {
  const mark = markFor("gitlab");
  assert.ok(mark);
  assert.equal(mark.kind, "brand");
  assert.equal(mark.brand.title, "GitLab");
  assert.equal(mark.brand.hex, "#FC6D26");
  assert.ok(mark.brand.colored);
  assert.equal(mark.brand.colored.viewBox, "0 0 50 48");
});

test("markFor resolves Postman logo", () => {
  const mark = markFor("postman");
  assert.ok(mark);
  assert.equal(mark.kind, "brand");
  assert.equal(mark.brand.title, "Postman");
  assert.equal(mark.brand.hex, "#FF6C37");
  assert.ok(mark.brand.colored);
  assert.equal(mark.brand.colored.viewBox, "0 0 32 32");
});

test("markFor resolves Google Workspace and Google logo with multi-colored SVG", () => {
  const wsMark = markFor("google-workspace", "Google");
  assert.ok(wsMark);
  assert.equal(wsMark.kind, "brand");
  assert.equal(wsMark.brand.title, "Google");
  assert.ok(wsMark.brand.colored);
  assert.equal(wsMark.brand.colored.viewBox, "0 0 24 24");

  const gMark = markFor("google");
  assert.ok(gMark);
  assert.equal(gMark.kind, "brand");
  assert.equal(gMark.brand.title, "Google");
  assert.ok(gMark.brand.colored);
  assert.equal(gMark.brand.colored.viewBox, "0 0 24 24");
});

test("markFor resolves Exa neural search logo", () => {
  const mark = markFor("exa", "Exa");
  assert.ok(mark);
  assert.equal(mark.kind, "brand");
  assert.equal(mark.brand.title, "Exa");
  assert.equal(mark.brand.hex, "#0143D9");
  assert.ok(mark.brand.colored);
  assert.equal(mark.brand.colored.viewBox, "0 0 24 24");
});
