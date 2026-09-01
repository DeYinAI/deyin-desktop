import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { createOAuthProvider, seedDevStorage } from "@deyin/oauth-provider";
import { OAuthClient } from "../src/client.js";
import { MemoryTokenStore } from "../src/stores/memory.js";
import { loginWithLoopback } from "../src/flows/loopback.js";
import { loginWithDevice } from "../src/flows/device.js";
import { OAuthClientError } from "../src/types.js";

let server: ServerType;
let baseUrl: string;

const CLIENT_ID = "deyin-desktop";
const SCOPES = ["openid", "profile", "email", "offline_access", "model:invoke"];

before(async () => {
  const { app } = await createOAuthProvider({
    storage: seedDevStorage(),
    // issuer is filled in after we know the port
    config: { issuer: "http://localhost", audience: "https://api.openference.com/v1" },
  });
  server = serve({ fetch: app.fetch, port: 0 });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://localhost:${port}`;
});

after(() => {
  server?.close();
});

function makeClient(store = new MemoryTokenStore()) {
  return new OAuthClient(
    {
      issuer: baseUrl,
      clientId: CLIENT_ID,
      scopes: SCOPES,
      // point discovery at the running server, but override endpoints so the issuer
      // string in the token (http://localhost) still validates for userinfo.
      endpoints: {
        authorizationEndpoint: `${baseUrl}/oauth/authorize`,
        tokenEndpoint: `${baseUrl}/oauth/token`,
        userinfoEndpoint: `${baseUrl}/oauth/userinfo`,
        deviceAuthorizationEndpoint: `${baseUrl}/oauth/device`,
        revocationEndpoint: `${baseUrl}/oauth/revoke`,
      },
    },
 store,
  );
}

/** Simulate the human step: approve consent at the provider, follow the redirect to loopback. */
async function approveInBrowser(authUrl: string) {
  const url = new URL(authUrl);
  const consent = await fetch(`${baseUrl}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({
      client_id: url.searchParams.get("client_id")!,
      redirect_uri: url.searchParams.get("redirect_uri")!,
      scope: url.searchParams.get("scope")!,
      state: url.searchParams.get("state")!,
      code_challenge: url.searchParams.get("code_challenge")!,
      code_challenge_method: url.searchParams.get("code_challenge_method")!,
      email: "demo@deyin.ai",
      decision: "allow",
    }),
  });
  const location = consent.headers.get("location");
  assert.ok(location, "provider redirects back to loopback");
  // Hitting the loopback callback drives the login to completion.
  await fetch(location!);
}

test("loopback login yields tokens and a profile", async () => {
  const client = makeClient();

  const tokens = await loginWithLoopback(client, {
    open: false,
    onAuthUrl: (authUrl) => {
      void approveInBrowser(authUrl);
    },
  });

  assert.ok(tokens.accessToken, "access token issued");
  assert.ok(tokens.refreshToken, "refresh token issued");
  assert.ok(await client.isAuthenticated());

  const user = await client.getUser();
  assert.equal(user.sub, "user_demo_001");
  assert.equal(user.email, "demo@deyin.ai");
  assert.equal(user.plan, "free");

  // getAccessToken returns the cached token while valid.
  const at = await client.getAccessToken();
  assert.equal(at, tokens.accessToken);

  // Forced refresh rotates the refresh token.
  const refreshed = await client.refresh();
  assert.ok(refreshed.accessToken);
  assert.notEqual(refreshed.refreshToken, tokens.refreshToken);

  // Logout clears the session.
  await client.logout();
  assert.equal(await client.isAuthenticated(), false);
});

test("device login polls until approved", async () => {
  const client = makeClient();

  const login = loginWithDevice(client, {
    onAuthorization: (info) => {
      // Approve out-of-band as soon as we have the user code.
      void fetch(`${baseUrl}/oauth/device/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          user_code: info.userCode,
          email: "demo@deyin.ai",
          decision: "allow",
        }),
      });
    },
  });

  const tokens = await login;
  assert.ok(tokens.accessToken, "device flow returns an access token");
});


test("refresh with a rejected refresh token clears the stored session", async () => {
 // Login, then rotate once: the provider consumes refresh tokens on use,
 // so tokens.refreshToken is now dead on the provider side.
 const client = makeClient();
 const tokens = await loginWithLoopback(client, {
  open: false,
  onAuthUrl: (authUrl) => {
   void approveInBrowser(authUrl);
  },
 });
 assert.ok(tokens.refreshToken, "refresh token issued");
 await client.refresh();

 // A client restored with the consumed refresh token (e.g. from a stale
 // credentials.json) must fail with invalid_grant...
 const stale = makeClient();
 await (stale as unknown as { store: { save(t: unknown): Promise<void> } }).store.save(tokens);
 await assert.rejects(
  () => stale.refresh(),
  (err: unknown) => err instanceof OAuthClientError && err.code === "invalid_grant",
 );
 // ...and clear the dead session instead of failing on every future request.
 assert.equal(await stale.isAuthenticated(), false);
});

