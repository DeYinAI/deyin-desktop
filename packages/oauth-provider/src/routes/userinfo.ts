import { type Context, Hono } from "hono";
import { jwtVerify } from "jose";
import { ENDPOINTS } from "../config.js";
import { oauthError, type ProviderContext } from "../context.js";

/** OIDC UserInfo endpoint. Returns claims for the subject of a valid access token. */
export function userinfoRoutes(ctx: ProviderContext): Hono {
  const app = new Hono();

  const handler = async (c: Context) => {
    const auth = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match) return c.json(oauthError("invalid_token", "Missing bearer token."), 401);

    try {
      const { payload } = await jwtVerify(match[1]!, ctx.keystore.publicKey, {
        issuer: ctx.config.issuer,
        audience: ctx.config.audience,
      });
      const scopes = new Set(String(payload.scope ?? "").split(/\s+/).filter(Boolean));
      const user = await ctx.storage.getUser(String(payload.sub));
      if (!user) return c.json(oauthError("invalid_token", "Unknown subject."), 401);

      return c.json({
        sub: user.sub,
        ...(scopes.has("email") ? { email: user.email, email_verified: user.emailVerified } : {}),
        ...(scopes.has("profile") ? { name: user.name, picture: user.picture } : {}),
        plan: user.plan,
      });
    } catch {
      return c.json(oauthError("invalid_token", "Token verification failed."), 401);
    }
  };

  app.get(ENDPOINTS.userinfo, handler);
  app.post(ENDPOINTS.userinfo, handler);
  return app;
}
