import assert from "node:assert/strict";
import test from "node:test";
import type { ChromeBridgeStatus } from "@deyin/contract";
import { connectionHeadline, groupCode, normalizeApprovedOrigin, originActionVerb } from "../src/chromeStatus.js";

function status(over: Partial<ChromeBridgeStatus> = {}): ChromeBridgeStatus {
  return {
    enabled: true,
    listening: true,
    port: 9410,
    extensionId: "x".repeat(32),
    connection: "disconnected",
    pairingCode: null,
    pairingOpenUntil: null,
    stopped: false,
    browser: null,
    pairedBrowsers: [],
    tabs: [],
    extensionPath: null,
    ...over,
  };
}

test("groupCode splits a six-digit code in half and leaves anything else alone", () => {
  assert.equal(groupCode("123456"), "123 456");
  assert.equal(groupCode("12345"), "12345");
});

test("headline: a relay that could not start is an error with the reason", () => {
  const h = connectionHeadline(status({ listening: false, error: "EADDRINUSE" }));
  assert.equal(h.tone, "bad");
  assert.equal(h.detail, "EADDRINUSE");
  assert.match(connectionHeadline(status({ listening: false })).detail ?? "", /9410/);
});

test("headline: stopped beats connected, and carries a refused-resume reason", () => {
  const h = connectionHeadline(status({ connection: "connected", stopped: true, error: "Resume from the extension popup." }));
  assert.equal(h.tone, "warn");
  assert.match(h.text, /Stopped/);
  assert.equal(h.detail, "Resume from the extension popup.");
  assert.equal("detail" in connectionHeadline(status({ stopped: true })), false);
});

test("headline covers every connection state", () => {
  const browser = { label: "Chrome 157", userAgent: "UA" };
  assert.deepEqual(connectionHeadline(status({ connection: "connected", browser })), { tone: "ok", text: "Connected to Chrome 157." });
  assert.match(connectionHeadline(status({ connection: "pairing", pairingCode: "123456" })).text, /Compare this code/);
  assert.match(connectionHeadline(status({ connection: "pairing" })).text, /Waiting for the extension/);
  const paired = connectionHeadline(status({ pairedBrowsers: [{ browserId: "b", label: "Work Chrome", pairedAt: 1 }] }));
  assert.equal(paired.tone, "muted");
  assert.match(paired.text, /Paired with Work Chrome/);
  assert.match(connectionHeadline(status()).text, /Not paired yet/);
});

test("normalizeApprovedOrigin accepts bare hosts and full URLs, keeping only the origin", () => {
  assert.deepEqual(normalizeApprovedOrigin("example.com"), { ok: true, origin: "https://example.com" });
  assert.deepEqual(normalizeApprovedOrigin("  http://localhost:3000/some/path?q=1 "), { ok: true, origin: "http://localhost:3000" });
  assert.deepEqual(normalizeApprovedOrigin("https://docs.example.org/a#b"), { ok: true, origin: "https://docs.example.org" });
});

test("normalizeApprovedOrigin rejects empty, malformed and non-web input", () => {
  for (const bad of ["", "   ", "http://", "chrome://settings", "file:///etc/passwd", "javascript:alert(1)"]) {
    const result = normalizeApprovedOrigin(bad);
    assert.equal(result.ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("originActionVerb words the common actions and falls back to a generic verb", () => {
  assert.equal(originActionVerb("open"), "open");
  assert.equal(originActionVerb("navigate"), "go to");
  assert.equal(originActionVerb("click"), "use");
});
