import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getReleaseNotes, CHANGELOG_RELEASES } from "../src/changelog.js";
import { parseChangelog } from "../../../../scripts/sync-changelog.js";

const here = dirname(fileURLToPath(import.meta.url));
const changelogPath = resolve(here, "../../../../docs/CHANGELOG.md");

test("getReleaseNotes finds exact version 1.0.21", () => {
  const notes = getReleaseNotes("1.0.21");
  assert.equal(notes.version, "1.0.21");
  assert.equal(notes.date, "2026-09-19");
  assert.equal(notes.isFallback, false);
  assert.ok(notes.content.includes("Promo Trial Plan Support"));
  assert.ok(notes.content.includes("Durable Checkpoints Revert"));
});

test("getReleaseNotes strips leading 'v'", () => {
  const notes = getReleaseNotes("v1.0.20");
  assert.equal(notes.version, "1.0.20");
  assert.equal(notes.date, "2026-09-04");
  assert.equal(notes.isFallback, false);
  assert.ok(notes.content.includes("Agnes-Video-2.5-Flash"));
});

test("getReleaseNotes matches prefix for dev/pre-release tags", () => {
  const notes = getReleaseNotes("1.0.21-dev.4");
  assert.equal(notes.version, "1.0.21");
  assert.equal(notes.isFallback, false);
});

test("getReleaseNotes falls back cleanly on unknown versions", () => {
  const notes = getReleaseNotes("99.99.99");
  assert.equal(notes.isFallback, true);
  assert.equal(notes.version, CHANGELOG_RELEASES[0]?.version);
});

test("changelogData stays in sync with docs/CHANGELOG.md", () => {
  const markdown = readFileSync(changelogPath, "utf-8");
  const parsed = parseChangelog(markdown);
  assert.ok(parsed.length >= 20, "Should parse at least 20 releases");
  assert.equal(parsed[0]?.version, CHANGELOG_RELEASES[0]?.version);
  assert.equal(parsed[0]?.content, CHANGELOG_RELEASES[0]?.content);
});
