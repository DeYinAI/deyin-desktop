import { Hono } from "hono";
import { html, raw } from "hono/html";
import { ENDPOINTS } from "../config.js";
import { filterScope, oauthError, type ProviderContext } from "../context.js";
import { randomToken, randomUserCode } from "../crypto.js";

/**
 * Device Authorization Grant (RFC 8628) for headless / SSH logins.
 * `POST /oauth/device` starts the flow; `GET/POST /oauth/device/verify` is the page
 * the user opens on a second device to approve the code.
 */
export function deviceRoutes(ctx: ProviderContext): Hono {
  const app = new Hono();

  app.post(ENDPOINTS.device, async (c) => {
    const body = await c.req.parseBody();
    const clientId = String(body.client_id ?? "");
    const client = await ctx.storage.getClient(clientId);
    if (!client) return c.json(oauthError("invalid_client"), 401);

    const scope = filterScope(String(body.scope ?? ""), client.allowedScopes);
    const deviceCode = randomToken(40);
    const userCode = randomUserCode();
    const verificationUri = ctx.config.issuer + "/oauth/device/verify";

    await ctx.storage.saveDeviceCode({
      deviceCode,
      userCode,
      clientId,
      scope,
      status: "pending",
      expiresAt: Date.now() + ctx.config.deviceCodeTtl * 1000,
      interval: ctx.config.devicePollInterval,
    });

    return c.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
      expires_in: ctx.config.deviceCodeTtl,
      interval: ctx.config.devicePollInterval,
    });
  });

  app.get("/oauth/device/verify", (c) => c.html(verifyPage(c.req.query("user_code") ?? "")));

  app.post("/oauth/device/verify", async (c) => {
    const body = await c.req.parseBody();
    const userCode = String(body.user_code ?? "").trim().toUpperCase();
    const email = String(body.email ?? "").trim();
    const decision = String(body.decision ?? "");

    const record = await ctx.storage.getDeviceCodeByUserCode(userCode);
    if (!record || record.expiresAt < Date.now()) {
      return c.html(verifyPage(userCode, "That code is invalid or has expired."), 400);
    }
    if (decision !== "allow") {
      record.status = "denied";
      await ctx.storage.updateDeviceCode(record);
      return c.html(resultPage("Request denied", "You can close this window."));
    }
    const user = await ctx.storage.findUserByEmail(email);
    if (!user) return c.html(verifyPage(userCode, "No account for that email."), 401);

    record.status = "approved";
    record.sub = user.sub;
    await ctx.storage.updateDeviceCode(record);
    return c.html(resultPage("Device approved", "You are signed in. Return to your terminal."));
  });

  return app;
}

function shell(title: string, inner: string) {
  return html`<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #0b0d0e; color: #e6e8ea; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { width: 360px; padding: 32px; border: 1px solid #23262a; border-radius: 16px; background: #111417; }
          h1 { font-size: 20px; margin: 0 0 16px; }
          label { display: block; font-size: 13px; color: #9aa0a6; margin: 12px 0 6px; }
          input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid #2a2e33; background: #0b0d0e; color: #e6e8ea; box-sizing: border-box; }
          .row { display: flex; gap: 10px; margin-top: 18px; }
          button { flex: 1; padding: 11px; border-radius: 10px; border: none; font-weight: 600; cursor: pointer; }
          .allow { background: #4f7cff; color: white; }
          .deny { background: transparent; color: #9aa0a6; border: 1px solid #2a2e33; }
          .msg { color: #ff6b6b; font-size: 13px; margin-top: 10px; }
          p { color: #9aa0a6; line-height: 1.5; }
        </style>
      </head>
      <body>
        <div class="card">${raw(inner)}</div>
      </body>
    </html>`;
}

function verifyPage(userCode: string, message?: string) {
  return shell(
    "Verify device — Openference",
    `<h1>Authorize device</h1>
     <form method="post" action="/oauth/device/verify">
       <label>Device code</label>
       <input name="user_code" value="${userCode.replace(/"/g, "&quot;")}" placeholder="WDJB-MJHT" required />
       <label>Email</label>
       <input type="email" name="email" placeholder="you@example.com" required />
       <div class="row">
         <button class="deny" type="submit" name="decision" value="deny">Deny</button>
         <button class="allow" type="submit" name="decision" value="allow">Approve</button>
       </div>
       ${message ? `<div class="msg">${message}</div>` : ""}
     </form>`,
  );
}

function resultPage(title: string, detail: string) {
  return shell(title, `<h1>${title}</h1><p>${detail}</p>`);
}
