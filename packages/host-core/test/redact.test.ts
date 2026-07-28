import assert from "node:assert/strict";
import { test } from "node:test";
import { isSecretKey, redactObject, redactText } from "../src/redact.js";

test("redactText scrubs Bearer tokens", () => {
  assert.equal(redactText("authorization: Bearer abc123.def-456_xyz"), "authorization: Bearer [redacted]");
});

test("redactText scrubs OAuth callback query params", () => {
  const url = "deyin://oauth/callback?code=secre7code&state=ok-state";
  const out = redactText(url);
  assert.ok(!out.includes("secre7code"), `code leaked in: ${out}`);
  assert.ok(out.includes("state=ok-state"), "non-secret param should survive");
});

test("redactText scrubs OpenAI-style keys and token= pairs", () => {
  assert.equal(redactText("key is sk-abcdef123456"), "key is sk-[redacted]");
  assert.ok(!redactText("access_token=hunter2 refresh_token=hunter3").includes("hunter"));
});

test("redactText leaves ordinary log lines untouched", () => {
  const line = "[identity] synced workspace deyin-desktop at 2026-07-28T12:00:00Z";
  assert.equal(redactText(line), line);
});

test("redactObject replaces values under secret-looking keys, recursively", () => {
  const input = {
    apiKey: "live-key",
    nested: { refreshToken: "tok", count: 3 },
    list: [{ password: "pw" }, "fine"],
  };
  const out = redactObject(input);
  assert.equal(out.apiKey, "[redacted]");
  assert.equal(out.nested.refreshToken, "[redacted]");
  assert.equal(out.nested.count, 3);
  assert.deepEqual(out.list, [{ password: "[redacted]" }, "fine"]);
  // Input object is not mutated.
  assert.equal(input.apiKey, "live-key");
});

test("redactObject scrubs token-looking strings even under innocent keys", () => {
  const out = redactObject({ note: "see Bearer very-secret-token" });
  assert.equal(out.note, "see Bearer [redacted]");
});

test("isSecretKey matches common secret names", () => {
  for (const key of ["apiKey", "api_key", "token", "accessToken", "secret", "password", "authorization", "sessionId"]) {
    assert.ok(isSecretKey(key), `expected ${key} to be secret`);
  }
  for (const key of ["theme", "fontSize", "workspace", "model"]) {
    assert.ok(!isSecretKey(key), `expected ${key} to be safe`);
  }
});
