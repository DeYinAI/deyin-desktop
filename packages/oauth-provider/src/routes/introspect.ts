import { Hono } from "hono";
import { jwtVerify } from "jose";
import { ENDPOINTS } from "../config.js";
import type { ProviderContext } from "../context.js";

/**
 * Token Introspection (RFC 7662). The web host-server calls this to validate an access
 * token before opening a session. Returns `{ active: false }` for anything invalid.
 */
export function introspectRoutes(ctx: ProviderContext): Hono {
  const app = new Hono();

  app.post(ENDPOINTS.introspect, async (c) => {
    const body = await c.req.parseBody();
    const token = String(body.token ?? "");
    if (!token) return c.json({ active: false });

    try {
      const { payload } = await jwtVerify(token, ctx.keystore.publicKey, {
        issuer: ctx.config.issuer,
        audience: ctx.config.audience,
      });
      return c.json({
        active: true,
        sub: payload.sub,
        scope: payload.scope,
        client_id: payload.client_id,
        token_type: "Bearer",
        exp: payload.exp,
        iat: payload.iat,
        iss: payload.iss,
        aud: payload.aud,
      });
    } catch {
      return c.json({ active: false });
    }
  });

  return app;
}
