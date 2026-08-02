import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import { join, resolve, sep } from "node:path";
import { app, safeStorage, shell } from "electron";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { McpAuthResult, McpAuthStatus, McpModuleManifest } from "../shared/types.js";
import { assertModuleId } from "./mcp-modules.js";
import { mcpOAuthCallbackStateValid } from "./mcp-oauth-state.js";

export { mcpOAuthCallbackStateValid } from "./mcp-oauth-state.js";

interface PersistedOAuthState {
  clients: Record<string, StoredOAuthClientInformation>;
  tokens: Record<string, StoredOAuthTokens>;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
  lastState?: string;
  redirectUrl?: string;
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Connected</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0d0e;color:#e6e8ea;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}
.card{padding:32px 40px;border:1px solid #23262a;border-radius:16px;background:#111417;text-align:center}
h1{font-size:18px;margin:0 0 8px}p{color:#9aa0a6;margin:0}</style></head>
<body><div class="card"><h1>MCP server connected</h1><p>You can close this tab and return to Deyin.</p></div></body></html>`;

/** Encrypted per-module OAuth state under <userData>/mcp-oauth/<moduleId>.json */
export class McpOAuthStore {
  constructor(private readonly rootDir = join(app.getPath("userData"), "mcp-oauth")) {}

  private path(moduleId: string): string {
    const safe = assertModuleId(moduleId);
    const root = resolve(this.rootDir);
    const resolved = join(root, `${safe}.json`);
    const abs = resolve(resolved);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error("OAuth path escapes root");
    }
    return abs;
  }

  load(moduleId: string): PersistedOAuthState {
    const file = this.path(moduleId);
    if (!existsSync(file)) return { clients: {}, tokens: {} };
    try {
      const raw = readFileSync(file, "utf8");
      const decrypted = this.decrypt(raw);
      const parsed = JSON.parse(decrypted) as PersistedOAuthState;
      return {
        clients: parsed.clients ?? {},
        tokens: parsed.tokens ?? {},
        codeVerifier: parsed.codeVerifier,
        discovery: parsed.discovery,
        lastState: parsed.lastState,
        redirectUrl: parsed.redirectUrl,
      };
    } catch {
      return { clients: {}, tokens: {} };
    }
  }

  save(moduleId: string, state: PersistedOAuthState): void {
    mkdirSync(this.rootDir, { recursive: true });
    const payload = JSON.stringify(state);
    writeFileSync(this.path(moduleId), this.encrypt(payload), { encoding: "utf8", mode: 0o600 });
  }

  delete(moduleId: string): void {
    const file = this.path(moduleId);
    if (existsSync(file)) rmSync(file, { force: true });
  }

  private encrypt(plaintext: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "Encrypted storage unavailable. OAuth tokens cannot be persisted securely.",
      );
    }
    return safeStorage.encryptString(plaintext).toString("base64");
  }

  private decrypt(ciphertext: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Encrypted storage unavailable.");
    }
    return safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
  }
}

class DesktopMcpOAuthProvider implements OAuthClientProvider {
  private persisted: PersistedOAuthState;

  constructor(
    private readonly moduleId: string,
    private readonly store: McpOAuthStore,
    readonly redirectUrl: string,
  ) {
    this.persisted = store.load(moduleId);
    this.persisted.redirectUrl = redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Deyin Desktop",
      redirect_uris: [this.redirectUrl],
      application_type: "native",
    };
  }

  state(): string {
    const value = crypto.randomUUID();
    this.persisted.lastState = value;
    this.store.save(this.moduleId, this.persisted);
    return value;
  }

  clientInformation(ctx?: OAuthClientInformationContext) {
    if (ctx?.issuer) return this.persisted.clients[ctx.issuer];
    const values = Object.values(this.persisted.clients);
    return values.at(-1);
  }

  saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): void {
    if (ctx?.issuer) this.persisted.clients[ctx.issuer] = info;
    this.store.save(this.moduleId, this.persisted);
  }

  tokens(ctx?: OAuthClientInformationContext) {
    if (ctx?.issuer) return this.persisted.tokens[ctx.issuer];
    const values = Object.values(this.persisted.tokens);
    return values.at(-1);
  }

  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
    const key = ctx?.issuer ?? tokens.issuer ?? "_default";
    this.persisted.tokens[key] = tokens;
    this.store.save(this.moduleId, this.persisted);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    void shell.openExternal(authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.persisted.codeVerifier = codeVerifier;
    this.store.save(this.moduleId, this.persisted);
  }

  codeVerifier(): string {
    if (!this.persisted.codeVerifier) throw new Error("No PKCE code verifier for MCP OAuth session.");
    return this.persisted.codeVerifier;
  }

  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    this.persisted.discovery = discovery;
    this.store.save(this.moduleId, this.persisted);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.persisted.discovery;
  }

  lastState(): string | undefined {
    return this.persisted.lastState;
  }

  clearTransientOAuthState(): void {
    delete this.persisted.codeVerifier;
    delete this.persisted.discovery;
    delete this.persisted.lastState;
    this.store.save(this.moduleId, this.persisted);
  }
}

function tokenIsValid(tokens: StoredOAuthTokens | undefined): boolean {
  return Boolean(tokens?.access_token);
}

export class McpOAuthService {
  private readonly store = new McpOAuthStore();
  private readonly authInProgress = new Set<string>();

  getProvider(moduleId: string): OAuthClientProvider {
    const saved = this.store.load(moduleId);
    const redirectUrl = saved.redirectUrl ?? "http://127.0.0.1/callback";
    return new DesktopMcpOAuthProvider(moduleId, this.store, redirectUrl);
  }

  isAuthenticated(moduleId: string): boolean {
    const saved = this.store.load(moduleId);
    return Object.values(saved.tokens).some((t) => tokenIsValid(t));
  }

  revoke(moduleId: string): void {
    this.store.delete(moduleId);
  }

  statusForModules(modules: McpModuleManifest[]): Record<string, McpAuthStatus> {
    const out: Record<string, McpAuthStatus> = {};
    for (const mod of modules) {
      if (mod.authMode !== "oauth" && !mod.usesNativeOAuth) continue;
      const saved = this.store.load(mod.id);
      const tokens = Object.values(saved.tokens);
      if (tokens.length === 0) {
        out[mod.id] = "none";
      } else if (tokens.some((t) => tokenIsValid(t))) {
        out[mod.id] = "authenticated";
      } else {
        out[mod.id] = "expired";
      }
    }
    return out;
  }

  async authenticate(moduleId: string, mcpUrl: string): Promise<McpAuthResult> {
    const safeId = assertModuleId(moduleId);
    if (this.authInProgress.has(safeId)) {
      return { ok: false, message: "Authentication already in progress for this module." };
    }
    this.authInProgress.add(safeId);

    const timeoutMs = 300_000;
    const redirectPath = "/callback";

    try {
      return await new Promise<McpAuthResult>((resolve) => {
      let redirectUri = "";
      let provider: DesktopMcpOAuthProvider | null = null;
      let transport: StreamableHTTPClientTransport | null = null;

      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== redirectPath) {
          res.writeHead(404).end();
          return;
        }

        const finish = (statusHtml: string, status = 200) => {
          res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(statusHtml);
          server.close();
          clearTimeout(timer);
        };

        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        if (error) {
          finish(`<p>Authorization failed.</p>`, 400);
          resolve({ ok: false, message: `Authorization failed: ${error}` });
          return;
        }
        if (!provider || !mcpOAuthCallbackStateValid(returnedState, provider.lastState())) {
          finish("<p>State mismatch. Please try again.</p>", 400);
          resolve({ ok: false, message: "State mismatch (possible CSRF)." });
          return;
        }
        if (!transport) {
          finish("<p>Missing transport.</p>", 500);
          resolve({ ok: false, message: "Internal OAuth error." });
          return;
        }

        try {
          await transport.finishAuth(url.searchParams);
          finish(SUCCESS_HTML);
          provider?.clearTransientOAuthState();

          const freshTransport = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider! });
          const client = new Client({ name: "deyin", version: "0.1.0" }, { capabilities: {} });
          await client.connect(freshTransport);
          const { tools } = await client.listTools();
          await client.close();
          resolve({ ok: true, toolCount: tools.length, message: `Connected (${tools.length} tools).` });
        } catch (err) {
          finish("<p>Could not complete authorization.</p>", 500);
          resolve({
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });

      const timer = setTimeout(() => {
        server.close();
        resolve({ ok: false, message: "OAuth timed out waiting for browser callback." });
      }, timeoutMs);

      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        redirectUri = `http://127.0.0.1:${port}${redirectPath}`;
        provider = new DesktopMcpOAuthProvider(safeId, this.store, redirectUri);
        transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider });
        const client = new Client({ name: "deyin", version: "0.1.0" }, { capabilities: {} });
        client
          .connect(transport)
          .then(async () => {
            const { tools } = await client.listTools();
            await client.close();
            provider?.clearTransientOAuthState();
            server.close();
            clearTimeout(timer);
            resolve({ ok: true, toolCount: tools.length, message: `Already connected (${tools.length} tools).` });
          })
          .catch((err) => {
            if (!(err instanceof UnauthorizedError)) {
              server.close();
              clearTimeout(timer);
              resolve({ ok: false, message: err instanceof Error ? err.message : String(err) });
            }
          });
      });
    });
    } finally {
      this.authInProgress.delete(safeId);
    }
  }
}
