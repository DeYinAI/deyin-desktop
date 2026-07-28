import { basename } from "node:path";
import { app } from "electron";
import {
  detectEnv,
  machineId,
  syncWorkspaceIdentity,
  truncateFingerprint,
  workspaceFingerprint,
  type AccountCache,
  type AgentsStore,
  type IdentityInfo,
  type IdentitySyncResult,
  type Storage,
} from "@deyin/host-core";
import type { DeyinConfig } from "../shared/config.js";
import type { AuthManager } from "./auth.js";
import { logLine } from "./logger.js";

interface IdentityServiceOptions {
  storage: Storage;
  config: DeyinConfig;
  auth: AuthManager;
  accountCache: AccountCache;
  agents: AgentsStore;
  getWorkspaceRoot: () => string | null;
}

interface IdentityMeta {
  lastSyncedAt: string | null;
}

/**
 * Assembles the live snapshot behind the Identity & Access page and pushes
 * device registrations to Openference. Every field comes from a real source —
 * the page never displays invented values.
 */
export class IdentityService {
  private readonly meta: IdentityMeta;

  constructor(private readonly opts: IdentityServiceOptions) {
    this.meta = opts.storage.readJson<IdentityMeta>("identity.json", { lastSyncedAt: null });
  }

  async info(): Promise<IdentityInfo> {
    const { auth, accountCache, agents, config } = this.opts;
    const root = this.opts.getWorkspaceRoot();
    const [user, env, account, id] = await Promise.all([
      auth.getUser(),
      detectEnv(),
      accountCache.get(),
      machineId(),
    ]);
    const full = workspaceFingerprint(id, root);
    return {
      member: user,
      plan: account?.planName ?? user?.plan ?? null,
      workspaceName: root ? basename(root) : null,
      workspaceRoot: root,
      device: env.hostname,
      platform: env.platform,
      arch: env.arch,
      version: app.getVersion(),
      fingerprint: truncateFingerprint(full),
      fingerprintFull: full,
      oauthIssuer: config.oauthIssuer,
      apiBaseUrl: config.apiBaseUrl,
      lastSyncedAt: this.meta.lastSyncedAt,
      server: account?.identity ?? null,
      localSecrets: agents.secretCount(),
    };
  }

  /** Register this workstation + workspace with Openference. */
  async sync(): Promise<IdentitySyncResult> {
    const info = await this.info();
    if (!info.member) return { ok: false, syncedAt: this.meta.lastSyncedAt, message: "Not signed in." };
    const syncedAt = await syncWorkspaceIdentity(this.opts.config, () => this.opts.auth.getAccessToken(), {
      fingerprint: info.fingerprintFull,
      hostname: info.device,
      platform: info.platform,
      arch: info.arch,
      appVersion: info.version,
      workspaceName: info.workspaceName,
    });
    if (!syncedAt) {
      logLine("warn", "[identity] sync failed (service unreachable)");
      return { ok: false, syncedAt: this.meta.lastSyncedAt, message: "Openference is unreachable right now." };
    }
    this.meta.lastSyncedAt = syncedAt;
    this.opts.storage.writeJson("identity.json", this.meta);
    logLine("info", `[identity] synced workspace ${info.workspaceName ?? "(none)"} at ${syncedAt}`);
    return { ok: true, syncedAt };
  }
}
