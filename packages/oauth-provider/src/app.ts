import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolveConfig, type ProviderConfig } from "./config.js";
import type { ProviderContext } from "./context.js";
import { createKeystore, type Keystore } from "./jwt.js";
import { authorizeRoutes } from "./routes/authorize.js";
import { deviceRoutes } from "./routes/device.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { introspectRoutes } from "./routes/introspect.js";
import { revokeRoutes } from "./routes/revoke.js";
import { tokenRoutes } from "./routes/token.js";
import { userinfoRoutes } from "./routes/userinfo.js";
import type { OAuthStorage } from "./storage/types.js";

export interface CreateProviderOptions {
  storage: OAuthStorage;
  config?: Partial<ProviderConfig>;
  keystore?: Keystore;
  keys?: { privateKeyPem?: string; publicKeyPem?: string; kid?: string };
  /** Allowed CORS origins for browser (SPA) clients hitting token/userinfo. */
  corsOrigins?: string[];
}

/**
 * Build the full OAuth provider as a Hono app. Runs on any Hono-compatible runtime
 * (Node via @hono/node-server, Cloudflare Workers, Bun, Deno).
 */
export async function createOAuthProvider(
  opts: CreateProviderOptions,
): Promise<{ app: Hono; ctx: ProviderContext }> {
  const config = resolveConfig(opts.config);
  const keystore = opts.keystore ?? (await createKeystore(opts.keys));
  const ctx: ProviderContext = { config, storage: opts.storage, keystore };

  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: opts.corsOrigins ?? "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true, issuer: config.issuer }));

  app.route("/", discoveryRoutes(ctx));
  app.route("/", authorizeRoutes(ctx));
  app.route("/", tokenRoutes(ctx));
  app.route("/", deviceRoutes(ctx));
  app.route("/", userinfoRoutes(ctx));
  app.route("/", introspectRoutes(ctx));
  app.route("/", revokeRoutes(ctx));

  return { app, ctx };
}
