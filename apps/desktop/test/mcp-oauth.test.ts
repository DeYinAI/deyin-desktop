import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpOAuthCallbackStateValid } from "../src/main/mcp-oauth-state.js";

test("mcpOAuthCallbackStateValid accepts matching state", () => {
  assert.equal(mcpOAuthCallbackStateValid("abc-123", "abc-123"), true);
});

test("mcpOAuthCallbackStateValid rejects mismatch, empty, or missing expected state", () => {
  assert.equal(mcpOAuthCallbackStateValid("abc", "xyz"), false);
  assert.equal(mcpOAuthCallbackStateValid(null, "abc"), false);
  assert.equal(mcpOAuthCallbackStateValid("", "abc"), false);
  assert.equal(mcpOAuthCallbackStateValid("abc", undefined), false);
});

test("mcpOAuthCallbackStateValid simulates persisted state round-trip", () => {
  const issued = crypto.randomUUID();
  const persisted = { lastState: issued };
  assert.equal(mcpOAuthCallbackStateValid(issued, persisted.lastState), true);
  assert.equal(mcpOAuthCallbackStateValid("tampered", persisted.lastState), false);
});
