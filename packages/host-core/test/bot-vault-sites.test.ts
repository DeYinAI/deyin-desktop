import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalHost, matchingSite, normalizeSite, pageHost, siteCovers } from "../src/bots/vault-sites.js";

test("a site is the host a person means, however they wrote it", () => {
  assert.equal(normalizeSite("github.com"), "github.com");
  assert.equal(normalizeSite("  GitHub.com  "), "github.com");
  assert.equal(normalizeSite("https://github.com/login?x=1#top"), "github.com");
  assert.equal(normalizeSite("http://login.github.com:8443/a"), "login.github.com");
  assert.equal(normalizeSite("github.com."), "github.com");
  assert.equal(normalizeSite("localhost:3000"), "localhost");
  assert.equal(normalizeSite("127.0.0.1"), "127.0.0.1");
});

test("an address with a password in it, or that is not a web address, is not a site", () => {
  assert.equal(normalizeSite("https://user:pw@github.com"), null);
  assert.equal(normalizeSite("https://github.com@evil.example"), null);
  for (const bad of ["ftp://github.com", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "", "   ", "http://", "https://exa mple.com"]) {
    assert.equal(normalizeSite(bad), null, bad);
  }
  assert.equal(normalizeSite(42), null);
  assert.equal(normalizeSite(null), null);
  assert.equal(normalizeSite("a".repeat(3000)), null);
  assert.equal(normalizeSite(`example.com/${"a".repeat(3000)}`), null, "an enormous address is refused, not parsed");
});

test("a single label, a shared suffix and a malformed address cannot be saved", () => {
  for (const bad of ["com", "intranet", "co.uk", "github.io", "pages.dev", "amazonaws.com", "999.999.999.999", "1.2.3.456", "example.123", "-bad.example", "bad-.example", "a..b.example", "[::2]", "http://[2001:db8::1]/"]) {
    assert.equal(normalizeSite(bad), null, bad);
  }
  assert.equal(normalizeSite("mine.co.uk"), "mine.co.uk", "a site under a suffix is fine");
  assert.equal(normalizeSite("alice.github.io"), "alice.github.io");
  assert.equal(normalizeSite("[::1]"), "[::1]");
});

test("a lookalike host is stored as the host the browser would really use", () => {
  assert.equal(normalizeSite("münchen.de"), "xn--mnchen-3ya.de");
  assert.equal(normalizeSite("аpple.com")?.startsWith("xn--"), true, "a Cyrillic а does not become apple.com");
  assert.notEqual(normalizeSite("аpple.com"), "apple.com");
});

test("a page is only one to fill when it is https, or http on this machine", () => {
  assert.equal(pageHost("https://github.com/login"), "github.com");
  assert.equal(pageHost("HTTPS://Login.GitHub.com:8443/x"), "login.github.com");
  assert.equal(pageHost("http://localhost:3000/"), "localhost");
  assert.equal(pageHost("http://127.0.0.1:8080"), "127.0.0.1");
  assert.equal(pageHost("http://github.com/login"), null, "plain http would send the password in the clear");
  for (const bad of ["https://user:pw@github.com/", "file:///a", "about:blank", "data:text/html,x", "blob:https://github.com/1", "javascript:1", "", "not a url"]) {
    assert.equal(pageHost(bad), null, bad);
  }
});

test("a saved site covers itself and its subdomains, and nothing that only resembles it", () => {
  assert.equal(siteCovers("github.com", "github.com"), true);
  assert.equal(siteCovers("github.com", "login.github.com"), true);
  assert.equal(siteCovers("github.com", "a.b.github.com"), true);
  assert.equal(siteCovers("github.com", "github.com.evil.example"), false);
  assert.equal(siteCovers("github.com", "evil-github.com"), false);
  assert.equal(siteCovers("github.com", "notgithub.com"), false);
  assert.equal(siteCovers("login.github.com", "github.com"), false, "a subdomain login is not the parent's");
  assert.equal(siteCovers("github.com", "xn--githb-bsa.com"), false);
});

test("an address or localhost covers only itself", () => {
  assert.equal(siteCovers("127.0.0.1", "127.0.0.1"), true);
  assert.equal(siteCovers("localhost", "localhost"), true);
  assert.equal(siteCovers("localhost", "app.localhost"), false);
  assert.equal(siteCovers("10.0.0.1", "1.10.0.0.1"), false);
  assert.equal(siteCovers("0.0.1", "10.0.0.1"), false);
  assert.equal(isLocalHost("localhost"), true);
  assert.equal(isLocalHost("[::1]"), true);
  assert.equal(isLocalHost("localhost.evil.example"), false);
});

test("the saved site that covers a page is returned, and none for a page that is not covered", () => {
  const sites = ["example.com", "github.com"];
  assert.equal(matchingSite(sites, "https://login.github.com/session"), "github.com");
  assert.equal(matchingSite(sites, "https://example.com/"), "example.com");
  assert.equal(matchingSite(sites, "https://github.com.evil.example/login"), null);
  assert.equal(matchingSite(sites, "http://github.com/login"), null);
  assert.equal(matchingSite(sites, "https://other.org"), null);
  assert.equal(matchingSite([], "https://github.com"), null);
  assert.equal(matchingSite(sites, "https://github.com@evil.example/"), null);
});
