import assert from "node:assert/strict";
import { test } from "node:test";
import { matchGlob } from "../src/tools/globmatch.js";

test("* stays within one segment, ** crosses segments", () => {
  assert.equal(matchGlob("src/index.ts", "src/*.ts"), true);
  assert.equal(matchGlob("src/deep/index.ts", "src/*.ts"), false);
  assert.equal(matchGlob("src/deep/index.ts", "src/**/*.ts"), true);
  assert.equal(matchGlob("index.ts", "**/*.ts"), true);
});

test("bare filename patterns match at any depth", () => {
  assert.equal(matchGlob("a/b/c/config.json", "config.json"), true);
  assert.equal(matchGlob("a/b/c/config.json", "*.json"), true);
  assert.equal(matchGlob("a/b/c/config.json", "*.ts"), false);
});

test("? matches exactly one character", () => {
  assert.equal(matchGlob("a1.txt", "a?.txt"), true);
  assert.equal(matchGlob("a12.txt", "a?.txt"), false);
});

test("{a,b} alternation and dots are literal", () => {
  assert.equal(matchGlob("main.test.ts", "*.{test,spec}.ts"), true);
  assert.equal(matchGlob("main.spec.ts", "*.{test,spec}.ts"), true);
  assert.equal(matchGlob("mainXtest.ts", "*.{test,spec}.ts"), false);
});

test("windows separators are normalized", () => {
  assert.equal(matchGlob("src\\index.ts", "src/*.ts"), true);
});
