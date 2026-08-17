import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import type { OAuthClient } from "../client.js";
import { generatePkce, generateState } from "../pkce.js";
import { openBrowser } from "../util/open-browser.js";
import { OAuthClientError, type TokenSet } from "../types.js";

export interface LoopbackLoginOptions {
  /** Callback path on the loopback server. Must match a registered redirect. Default "/callback". */
  redirectPath?: string;
  /** Open the URL for the user. Defaults to the system browser. Set false to only print it. */
  open?: boolean;
  /** Called with the authorization URL (for logging / manual paste fallback). */
  onAuthUrl?: (url: string) => void;
  /** Give up after this many ms. Default 300000 (5 min). */
  timeoutMs?: number;
  /** HTML shown in the browser tab after a successful callback. */
  successHtml?: string;
}

const DEFAULT_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0d0e;color:#e6e8ea;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}
.card{padding:32px 40px;border:1px solid #23262a;border-radius:16px;background:#111417;text-align:center}
h1{font-size:18px;margin:0 0 8px}p{color:#9aa0a6;margin:0}</style></head>
<body><div class="card"><h1>You're signed in to Deyin</h1><p>You can close this tab and return to the app.</p></div></body></html>`;

/**
 * Desktop / native loopback login (RFC 8252). Binds a one-shot HTTP server on
 * 127.0.0.1, opens the browser to the authorization endpoint, waits for the redirect,
 * verifies state, and exchanges the code for tokens.
 */
export async function loginWithLoopback(
  client: OAuthClient,
  options: LoopbackLoginOptions = {},
): Promise<TokenSet> {
  const endpoints = await client.getEndpoints();
  const pkce = await generatePkce();
  const state = generateState();
  const redirectPath = options.redirectPath ?? "/callback";
  const timeoutMs = options.timeoutMs ?? 300_000;

  return new Promise<TokenSet>((resolve, reject) => {
    // Captured once the server is listening, so it survives server.close().
    let redirectUri = "";

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== redirectPath) {
        res.writeHead(404).end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      const finish = (statusHtml: string, status = 200) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(statusHtml);
        server.close();
        clearTimeout(timer);
      };

      if (error) {
        finish(`<p>Authorization failed: ${error}</p>`, 400);
        reject(new OAuthClientError(`Authorization error: ${error}`, error));
        return;
      }
      if (!returnedState || returnedState !== state) {
        finish("<p>State mismatch. Please try again.</p>", 400);
        reject(new OAuthClientError("State mismatch (possible CSRF).", "state_mismatch"));
        return;
      }
      if (!code) {
        finish("<p>Missing authorization code.</p>", 400);
        reject(new OAuthClientError("No authorization code returned.", "no_code"));
        return;
      }

      finish(options.successHtml ?? DEFAULT_SUCCESS_HTML);
      client
        .exchangeCode({ code, codeVerifier: pkce.verifier, redirectUri })
        .then(resolve)
        .catch(reject);
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new OAuthClientError("Login timed out.", "timeout"));
    }, timeoutMs);

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(new OAuthClientError("Loopback server error.", "server_error", err));
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      redirectUri = `http://127.0.0.1:${port}${redirectPath}`;
      const authUrl = new URL(endpoints.authorizationEndpoint);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", client.config.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", client.config.scopes.join(" "));
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", pkce.challenge);
      authUrl.searchParams.set("code_challenge_method", pkce.method);

      const urlString = authUrl.toString();
      options.onAuthUrl?.(urlString);
      if (options.open !== false) openBrowser(urlString);
    });
  });
}
