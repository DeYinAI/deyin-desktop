import { Hono } from "hono";
import { html, raw } from "hono/html";
import { ENDPOINTS } from "../config.js";
import { filterScope, redirectUriAllowed, type ProviderContext } from "../context.js";
import { randomToken } from "../crypto.js";

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  state?: string;
  nonce?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

function errorPage(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:system-ui,sans-serif;background:#0b0d0e;color:#e6e8ea;display:flex;
  align-items:center;justify-content:center;height:100vh;margin:0}
  .card{max-width:420px;padding:32px;border:1px solid #23262a;border-radius:16px;background:#111417}
  h1{font-size:18px;margin:0 0 8px}p{color:#9aa0a6;line-height:1.5;margin:0}</style></head>
  <body><div class="card"><h1>${title}</h1><p>${detail}</p></div></body></html>`;
}

/**
 * Authorization endpoint (RFC 6749 §4.1 + PKCE). In dev this renders a login+consent
 * form; in production the handler would resolve the already-authenticated Openference
 * session (Google/GitHub) and only render the consent step.
 */
export function authorizeRoutes(ctx: ProviderContext): Hono {
  const app = new Hono();

  app.get(ENDPOINTS.authorize, async (c) => {
    const q = c.req.query();
    const params: AuthorizeParams = {
      clientId: q.client_id ?? "",
      redirectUri: q.redirect_uri ?? "",
      scope: q.scope ?? "",
      state: q.state,
      nonce: q.nonce,
      codeChallenge: q.code_challenge ?? "",
      codeChallengeMethod: q.code_challenge_method ?? "",
    };

    const client = await ctx.storage.getClient(params.clientId);
    if (!client) {
      return c.html(errorPage("Unknown client", "The client_id is not registered."), 400);
    }
    if (!redirectUriAllowed(client.redirectUris, params.redirectUri)) {
      return c.html(
        errorPage("Invalid redirect", "redirect_uri does not match a registered value."),
        400,
      );
    }

    // From here, errors are delivered back to the client via redirect.
    const redirectError = (error: string, description: string) => {
      const url = new URL(params.redirectUri);
      url.searchParams.set("error", error);
      url.searchParams.set("error_description", description);
      if (params.state) url.searchParams.set("state", params.state);
      return c.redirect(url.toString());
    };

    if (q.response_type !== "code") {
      return redirectError("unsupported_response_type", "Only response_type=code is supported.");
    }
    if (params.codeChallengeMethod !== "S256" || !params.codeChallenge) {
      return redirectError("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    const grantedScope = filterScope(params.scope, client.allowedScopes);

    const scopeList = grantedScope.split(/\s+/).filter(Boolean);
    return c.html(consentPage(params, client.name, scopeList));
  });

  app.post(ENDPOINTS.authorize, async (c) => {
    const body = await c.req.parseBody();
    const params: AuthorizeParams = {
      clientId: String(body.client_id ?? ""),
      redirectUri: String(body.redirect_uri ?? ""),
      scope: String(body.scope ?? ""),
      state: body.state ? String(body.state) : undefined,
      nonce: body.nonce ? String(body.nonce) : undefined,
      codeChallenge: String(body.code_challenge ?? ""),
      codeChallengeMethod: String(body.code_challenge_method ?? ""),
    };
    const email = String(body.email ?? "").trim();
    const decision = String(body.decision ?? "");

    const client = await ctx.storage.getClient(params.clientId);
    if (!client || !redirectUriAllowed(client.redirectUris, params.redirectUri)) {
      return c.html(errorPage("Invalid request", "Client or redirect_uri is invalid."), 400);
    }

    const url = new URL(params.redirectUri);
    if (params.state) url.searchParams.set("state", params.state);

    if (decision !== "allow") {
      url.searchParams.set("error", "access_denied");
      url.searchParams.set("error_description", "The user denied the request.");
      return c.redirect(url.toString());
    }

    const user = await ctx.storage.findUserByEmail(email);
    if (!user) {
      const grantedScope = filterScope(params.scope, client.allowedScopes);
      return c.html(
        consentPage(params, client.name, grantedScope.split(/\s+/).filter(Boolean), "No account for that email."),
        401,
      );
    }

    const code = randomToken(32);
    await ctx.storage.saveAuthorizationCode({
      code,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      sub: user.sub,
      scope: filterScope(params.scope, client.allowedScopes),
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: "S256",
      nonce: params.nonce,
      expiresAt: Date.now() + ctx.config.authCodeTtl * 1000,
    });

    url.searchParams.set("code", code);
    return c.redirect(url.toString());
  });

  return app;
}

function consentPage(
  params: AuthorizeParams,
  clientName: string,
  scopes: string[],
  message?: string,
) {
  const hidden = (name: string, value: string | undefined) =>
    value === undefined ? "" : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

  return html`<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Sign in — Openference</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #0b0d0e; color: #e6e8ea; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { width: 380px; padding: 32px; border: 1px solid #23262a; border-radius: 16px; background: #111417; }
          h1 { font-size: 20px; margin: 0 0 4px; }
          .sub { color: #9aa0a6; font-size: 14px; margin: 0 0 20px; }
          label { display: block; font-size: 13px; color: #9aa0a6; margin: 12px 0 6px; }
          input[type="email"] { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid #2a2e33; background: #0b0d0e; color: #e6e8ea; box-sizing: border-box; }
          .scopes { margin: 16px 0; padding: 12px; border-radius: 10px; background: #0b0d0e; border: 1px solid #23262a; }
          .scopes li { color: #c9ced3; font-size: 13px; }
          .row { display: flex; gap: 10px; margin-top: 18px; }
          button { flex: 1; padding: 11px; border-radius: 10px; border: none; font-weight: 600; cursor: pointer; }
          .allow { background: #4f7cff; color: white; }
          .deny { background: transparent; color: #9aa0a6; border: 1px solid #2a2e33; }
          .msg { color: #ff6b6b; font-size: 13px; margin-top: 10px; }
        </style>
      </head>
      <body>
        <form class="card" method="post" action="${ENDPOINTS.authorize}">
          <h1>Continue to ${escapeHtml(clientName)}</h1>
          <p class="sub">Sign in with your Openference account</p>
          <label>Email</label>
          <input type="email" name="email" placeholder="you@example.com" required />
          <div class="scopes">
            <div style="font-size:12px;color:#7a8087;margin-bottom:6px">This app will be able to:</div>
            <ul style="margin:0;padding-left:18px">
              ${raw(scopes.map((s) => `<li>${escapeHtml(scopeLabel(s))}</li>`).join(""))}
            </ul>
          </div>
          ${hidden("client_id", params.clientId)} ${hidden("redirect_uri", params.redirectUri)}
          ${hidden("scope", params.scope)} ${hidden("state", params.state)}
          ${hidden("nonce", params.nonce)} ${hidden("code_challenge", params.codeChallenge)}
          ${hidden("code_challenge_method", params.codeChallengeMethod)}
          <div class="row">
            <button class="deny" type="submit" name="decision" value="deny">Cancel</button>
            <button class="allow" type="submit" name="decision" value="allow">Allow</button>
          </div>
          ${message ? raw(`<div class="msg">${escapeHtml(message)}</div>`) : ""}
        </form>
      </body>
    </html>`;
}

function scopeLabel(scope: string): string {
  const labels: Record<string, string> = {
    openid: "Verify your identity",
    profile: "See your name and avatar",
    email: "See your email address",
    offline_access: "Stay signed in (refresh tokens)",
    "model:invoke": "Send requests to Openference models on your behalf",
  };
  return labels[scope] ?? scope;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
