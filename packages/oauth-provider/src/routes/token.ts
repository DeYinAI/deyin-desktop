import { type Context, Hono } from "hono";
import { ENDPOINTS } from "../config.js";
import { oauthError, type ProviderContext } from "../context.js";
import { randomToken, timingSafeEqual, verifyPkce } from "../crypto.js";
import { signAccessToken, signIdToken } from "../jwt.js";
import type { OAuthClient, UserProfile } from "../storage/types.js";

interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
  id_token?: string;
}

export function tokenRoutes(ctx: ProviderContext): Hono {
  const app = new Hono();

  app.post(ENDPOINTS.token, async (c) => {
    const body = await c.req.parseBody();
    const grantType = String(body.grant_type ?? "");

    const client = await authenticateClient(ctx, body);
    if (!client) {
      return c.json(oauthError("invalid_client", "Client authentication failed."), 401);
    }
    if (!client.grantTypes.includes(grantType as OAuthClient["grantTypes"][number])) {
      return c.json(oauthError("unauthorized_client", `Client may not use ${grantType}.`), 400);
    }

    switch (grantType) {
      case "authorization_code":
        return handleAuthCode(c, ctx, client, body);
      case "refresh_token":
        return handleRefresh(c, ctx, client, body);
      case "urn:ietf:params:oauth:grant-type:device_code":
        return handleDeviceCode(c, ctx, client, body);
      default:
        return c.json(oauthError("unsupported_grant_type"), 400);
    }
  });

  return app;
}

async function authenticateClient(
  ctx: ProviderContext,
  body: Record<string, unknown>,
): Promise<OAuthClient | undefined> {
  const clientId = String(body.client_id ?? "");
  const client = await ctx.storage.getClient(clientId);
  if (!client) return undefined;
  if (client.isPublic) return client; // public client => PKCE proves possession
  const secret = String(body.client_secret ?? "");
  if (!client.secretHash || !timingSafeEqual(secret, client.secretHash)) return undefined;
  return client;
}

async function issueTokens(
  ctx: ProviderContext,
  client: OAuthClient,
  user: UserProfile,
  scope: string,
  nonce?: string,
): Promise<TokenResponse> {
  const scopes = new Set(scope.split(/\s+/).filter(Boolean));

  const access_token = await signAccessToken(ctx.keystore, ctx.config, {
    sub: user.sub,
    clientId: client.clientId,
    scope,
    plan: user.plan,
  });

  const response: TokenResponse = {
    access_token,
    token_type: "Bearer",
    expires_in: ctx.config.accessTokenTtl,
    scope,
  };

  if (scopes.has("offline_access")) {
    const refresh_token = randomToken(48);
    await ctx.storage.saveRefreshToken({
      token: refresh_token,
      clientId: client.clientId,
      sub: user.sub,
      scope,
      expiresAt: Date.now() + ctx.config.refreshTokenTtl * 1000,
    });
    response.refresh_token = refresh_token;
  }

  if (scopes.has("openid")) {
    response.id_token = await signIdToken(ctx.keystore, ctx.config, {
      sub: user.sub,
      clientId: client.clientId,
      email: scopes.has("email") ? user.email : undefined,
      emailVerified: scopes.has("email") ? user.emailVerified : undefined,
      name: scopes.has("profile") ? user.name : undefined,
      picture: scopes.has("profile") ? user.picture : undefined,
      nonce,
    });
  }

  return response;
}

async function handleAuthCode(
  c: Context,
  ctx: ProviderContext,
  client: OAuthClient,
  body: Record<string, unknown>,
) {
  const code = String(body.code ?? "");
  const redirectUri = String(body.redirect_uri ?? "");
  const codeVerifier = String(body.code_verifier ?? "");

  const record = await ctx.storage.takeAuthorizationCode(code);
  if (!record) return c.json(oauthError("invalid_grant", "Authorization code is invalid or expired."), 400);
  if (record.clientId !== client.clientId) return c.json(oauthError("invalid_grant", "Code was issued to another client."), 400);
  if (record.redirectUri !== redirectUri) return c.json(oauthError("invalid_grant", "redirect_uri mismatch."), 400);

  const pkceOk = await verifyPkce(codeVerifier, record.codeChallenge, record.codeChallengeMethod);
  if (!pkceOk) return c.json(oauthError("invalid_grant", "PKCE verification failed."), 400);

  const user = await ctx.storage.getUser(record.sub);
  if (!user) return c.json(oauthError("invalid_grant", "User no longer exists."), 400);

  return c.json(await issueTokens(ctx, client, user, record.scope, record.nonce));
}

async function handleRefresh(
  c: Context,
  ctx: ProviderContext,
  client: OAuthClient,
  body: Record<string, unknown>,
) {
  const token = String(body.refresh_token ?? "");
  const record = await ctx.storage.takeRefreshToken(token); // rotation: consume on use
  if (!record || record.clientId !== client.clientId) {
    return c.json(oauthError("invalid_grant", "Refresh token is invalid or expired."), 400);
  }
  const user = await ctx.storage.getUser(record.sub);
  if (!user) return c.json(oauthError("invalid_grant", "User no longer exists."), 400);

  // Optional down-scoping on refresh.
  const requested = body.scope ? String(body.scope) : record.scope;
  const requestedSet = new Set(requested.split(/\s+/).filter(Boolean));
  const grantedScope = record.scope
    .split(/\s+/)
    .filter((s) => requestedSet.has(s))
    .join(" ");

  return c.json(await issueTokens(ctx, client, user, grantedScope || record.scope));
}

async function handleDeviceCode(
  c: Context,
  ctx: ProviderContext,
  client: OAuthClient,
  body: Record<string, unknown>,
) {
  const deviceCode = String(body.device_code ?? "");
  const record = await ctx.storage.getDeviceCodeByDeviceCode(deviceCode);
  if (!record || record.clientId !== client.clientId) {
    return c.json(oauthError("invalid_grant", "Unknown device_code."), 400);
  }
  if (record.expiresAt < Date.now()) {
    return c.json(oauthError("expired_token", "The device_code has expired."), 400);
  }

  // slow_down: reject polls faster than the advertised interval.
  const now = Date.now();
  if (record.lastPolledAt && now - record.lastPolledAt < record.interval * 1000) {
    record.lastPolledAt = now;
    await ctx.storage.updateDeviceCode(record);
    return c.json(oauthError("slow_down"), 400);
  }
  record.lastPolledAt = now;
  await ctx.storage.updateDeviceCode(record);

  if (record.status === "pending") return c.json(oauthError("authorization_pending"), 400);
  if (record.status === "denied") return c.json(oauthError("access_denied"), 400);

  const user = record.sub ? await ctx.storage.getUser(record.sub) : undefined;
  if (!user) return c.json(oauthError("access_denied", "Device request was not linked to a user."), 400);

  // One-shot: prevent reuse after success.
  record.status = "denied";
  await ctx.storage.updateDeviceCode(record);
  return c.json(await issueTokens(ctx, client, user, record.scope));
}
