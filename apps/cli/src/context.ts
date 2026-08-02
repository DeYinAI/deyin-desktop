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

export function createContext(opts: { cwd?: string; overrides?: Partial<DeyinCliConfigFile> } = {}): CliContext {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const dataDir = defaultDataDir();
  const config = loadCliConfig({ cwd, globalDir: dataDir, overrides: opts.overrides });
  const storage = new FileStorage(dataDir);
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
