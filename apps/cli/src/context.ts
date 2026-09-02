import { join, resolve } from "node:path";
import {
  SessionStore,
  loadCliConfig,
  type DeyinCliConfigFile,
  type ResolvedCliConfig,
} from "@deyin/agent-core";
import { DEFAULT_CONFIG, FileStorage, MemoryStore, UsageStore, defaultDataDir } from "@deyin/host-core";
import { OAuthClient } from "@deyin/oauth-client";
import { FileTokenStore } from "@deyin/oauth-client/node";

export interface CliContext {
  cwd: string;
  dataDir: string;
  config: ResolvedCliConfig;
  storage: FileStorage;
  oauth: OAuthClient;
  sessions: SessionStore;
  usage: UsageStore;
  memory: MemoryStore;
}

/** Storage instances created this process; flushed once when the loop drains. */
const liveStorages: FileStorage[] = [];
let exitFlushRegistered = false;

/**
 * Writes are async and coalescing, and each CLI command builds its own context,
 * so there is no shared "end of main" to flush at. `beforeExit` fires once the
 * event loop drains — i.e. after the command finished — and can still run IO;
 * it does not fire on explicit process.exit(), which no command path uses after
 * writing. The guard keeps the second drain (scheduled by the flush itself)
 * from re-entering.
 */
/**
 * Flush every storage created this process. `beforeExit` covers normal
 * exits, but explicit `process.exit()` (the headless runner) skips it — call
 * this before exiting manually.
 */
export async function flushCliStorage(): Promise<void> {
  await Promise.all(liveStorages.map((s) => s.flush())).catch(() => {});
}

function flushOnExit(storage: FileStorage): void {
  liveStorages.push(storage);
  if (exitFlushRegistered) return;
  exitFlushRegistered = true;
  process.once("beforeExit", () => {
    void Promise.all(liveStorages.map((s) => s.flush())).catch(() => {});
  });
}

export function createContext(opts: { cwd?: string; overrides?: Partial<DeyinCliConfigFile> } = {}): CliContext {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const dataDir = defaultDataDir();
  const config = loadCliConfig({ cwd, globalDir: dataDir, overrides: opts.overrides });
  const storage = new FileStorage(dataDir);
  flushOnExit(storage);
  const oauth = new OAuthClient(
    { issuer: config.oauthIssuer, clientId: config.clientId, scopes: DEFAULT_CONFIG.scopes },
    new FileTokenStore({ path: join(dataDir, "credentials.json") }),
  );
  return {
    cwd,
    dataDir,
    config,
    storage,
    oauth,
    sessions: new SessionStore(join(dataDir, "sessions")),
    usage: new UsageStore(storage),
    memory: new MemoryStore(dataDir),
  };
}

/** Access-token source for the agent loop; null when signed out or refresh fails. */
export function tokenSource(ctx: CliContext): () => Promise<string | null> {
  return async () => {
    const fromEnv = process.env.DEYIN_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    try {
      if (!(await ctx.oauth.isAuthenticated())) return null;
      return await ctx.oauth.getAccessToken();
    } catch {
      return null;
    }
  };
}
