import { Hono } from "hono";
import { ENDPOINTS } from "../config.js";
import type { ProviderContext } from "../context.js";

/**
 * Token Revocation (RFC 7009). Access tokens are stateless JWTs and expire quickly, so
 * revocation targets refresh tokens. Always returns 200 per the spec.
 */
export function revokeRoutes(ctx: ProviderContext): Hono {
  const app = new Hono();

  app.post(ENDPOINTS.revoke, async (c) => {
    const body = await c.req.parseBody();
    const token = String(body.token ?? "");
    if (token) await ctx.storage.revokeRefreshToken(token);
    return c.body(null, 200);
  });

  return app;
}
