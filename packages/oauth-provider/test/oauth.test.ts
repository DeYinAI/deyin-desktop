import assert from "node:assert/strict";
import { test } from "node:test";
import { createOAuthProvider } from "../src/app.js";
import { sha256Base64Url, randomToken } from "../src/crypto.js";
import { seedDevStorage } from "../src/storage/memory.js";

const CLIENT_ID = "deyin-desktop";
const REDIRECT = "http://127.0.0.1:49177/callback";
const SCOPE = "openid profile email offline_access model:invoke";

async function buildProvider() {
  return createOAuthProvider({
    storage: seedDevStorage(),
    config: { issuer: "http://localhost:8788", audience: "https://api.openference.com/v1" },
  });
}

test("discovery document advertises PKCE + all endpoints", async () => {
  const { app } = await buildProvider();
  const res = await app.request("/.well-known/openid-configuration");
  assert.equal(res.status, 200);
  const doc = (await res.json()) as Record<string, unknown>;
  assert.equal(doc.issuer, "http://localhost:8788");
  assert.deepEqual(doc.code_challenge_methods_supported, ["S256"]);
  assert.ok(String(doc.token_endpoint).endsWith("/oauth/token"));
  assert.ok(String(doc.device_authorization_endpoint).endsWith("/oauth/device"));
});

test("authorization code + PKCE issues verifiable tokens", async () => {
  const { app, ctx } = await buildProvider();

  const verifier = randomToken(32);
  const challenge = await sha256Base64Url(verifier);

  // Approve consent (POST /oauth/authorize) as the demo user.
  const realAuth = await app.request("/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: SCOPE,
      state: "xyz",
      code_challenge: challenge,
      code_challenge_method: "S256",
      email: "demo@deyin.dev",
      decision: "allow",
    }).toString(),
  });
  assert.equal(realAuth.status, 302);
  const location = realAuth.headers.get("location")!;
  const redirected = new URL(location);
  assert.equal(redirected.searchParams.get("state"), "xyz");
  const code = redirected.searchParams.get("code");
  assert.ok(code, "authorization code present");

  // Exchange the code.
  const tokenRes = await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(tokenRes.status, 200);
  const tokens = (await tokenRes.json()) as Record<string, string>;
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.access_token, "access token issued");
  assert.ok(tokens.refresh_token, "refresh token issued (offline_access)");
  assert.ok(tokens.id_token, "id token issued (openid)");

  // UserInfo with the access token.
  const userRes = await app.request("/oauth/userinfo", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  assert.equal(userRes.status, 200);
  const profile = (await userRes.json()) as Record<string, string>;
  assert.equal(profile.sub, "user_demo_001");
  assert.equal(profile.email, "demo@deyin.dev");

  // Introspection reports active.
  const introRes = await app.request("/oauth/introspect", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: tokens.access_token }).toString(),
  });
  const intro = (await introRes.json()) as Record<string, unknown>;
  assert.equal(intro.active, true);
  assert.equal(intro.sub, "user_demo_001");
  void ctx;

  // Refresh rotates the refresh token and returns a fresh access token.
  const refreshRes = await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token!,
      client_id: CLIENT_ID,
    }).toString(),
  });
  assert.equal(refreshRes.status, 200);
  const refreshed = (await refreshRes.json()) as Record<string, string>;
  assert.ok(refreshed.access_token);
  assert.ok(refreshed.refresh_token);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token, "refresh token rotated");
});

test("PKCE mismatch is rejected", async () => {
  const { app } = await buildProvider();
  const challenge = await sha256Base64Url(randomToken(32));

  const authRes = await app.request("/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: "openid",
      code_challenge: challenge,
      code_challenge_method: "S256",
      email: "demo@deyin.dev",
      decision: "allow",
    }).toString(),
  });
  const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;

  const tokenRes = await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: "the-wrong-verifier",
    }).toString(),
  });
  assert.equal(tokenRes.status, 400);
  const err = (await tokenRes.json()) as Record<string, string>;
  assert.equal(err.error, "invalid_grant");
});

test("device flow: pending -> approved -> tokens", async () => {
  const { app } = await buildProvider();

  const startRes = await app.request("/oauth/device", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: "openid model:invoke" }).toString(),
  });
  const start = (await startRes.json()) as Record<string, string>;
  assert.ok(start.device_code && start.user_code);

  // Poll before approval -> authorization_pending.
  const poll1 = await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: start.device_code!,
      client_id: CLIENT_ID,
    }).toString(),
  });
  assert.equal(poll1.status, 400);
  assert.equal(((await poll1.json()) as Record<string, string>).error, "authorization_pending");

  // Approve on the verification page.
  const approve = await app.request("/oauth/device/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      user_code: start.user_code!,
      email: "demo@deyin.dev",
      decision: "allow",
    }).toString(),
  });
  assert.equal(approve.status, 200);

  // Wait past the poll interval, then a successful poll returns tokens.
  await new Promise((r) => setTimeout(r, 5100));
  const poll2 = await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: start.device_code!,
      client_id: CLIENT_ID,
    }).toString(),
  });
  assert.equal(poll2.status, 200);
  const tokens = (await poll2.json()) as Record<string, string>;
  assert.ok(tokens.access_token);
});
