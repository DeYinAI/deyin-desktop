import assert from "node:assert/strict";
import { test } from "node:test";
import { chromeOriginRequiresConsent, originOfUrl } from "../src/main/chrome-origins.js";

test("originOfUrl normalizes bare hostnames and rejects invalid input", () => {
  assert.equal(originOfUrl("https://example.com/path"), "https://example.com");
  assert.equal(originOfUrl("example.com"), "https://example.com");
  assert.equal(originOfUrl("http://localhost:9222"), "http://localhost:9222");
  assert.equal(originOfUrl(""), null);
  assert.equal(originOfUrl("not a url!!!"), null);
});

test("chromeOriginRequiresConsent allows approved origins", () => {
  const approved = new Set(["https://example.com", "http://localhost:9222"]);
  assert.equal(chromeOriginRequiresConsent("https://example.com/a", approved), false);
  assert.equal(chromeOriginRequiresConsent("http://localhost:9222/json", approved), false);
});

test("chromeOriginRequiresConsent requires consent for unknown origins", () => {
  const approved = new Set(["https://example.com"]);
  assert.equal(chromeOriginRequiresConsent("https://other.com", approved), true);
  assert.equal(chromeOriginRequiresConsent("https://evil.example.com", approved), true);
});

test("chromeOriginRequiresConsent treats invalid URLs as needing consent", () => {
  const approved = new Set<string>();
  assert.equal(chromeOriginRequiresConsent("javascript:alert(1)", approved), true);
  assert.equal(chromeOriginRequiresConsent("", approved), true);
});
