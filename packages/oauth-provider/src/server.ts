import { serve } from "@hono/node-server";
import { createOAuthProvider } from "./app.js";
import { seedDevStorage } from "./storage/memory.js";

/**
 * Local dev server. Uses in-memory storage seeded with the `deyin-desktop` client and a
 * demo user, and an ephemeral signing key. Do not use in production.
 */
const port = Number(process.env.PORT ?? 8788);
const issuer = process.env.OAUTH_ISSUER ?? `http://localhost:${port}`;

const { app } = await createOAuthProvider({
  storage: seedDevStorage(),
  config: { issuer, audience: process.env.OAUTH_AUDIENCE ?? "https://api.openference.com/v1" },
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[deyin oauth] listening on http://localhost:${info.port}`);
  console.log(`[deyin oauth] discovery: ${issuer}/.well-known/openid-configuration`);
  console.log(`[deyin oauth] demo user: demo@deyin.dev`);
});
