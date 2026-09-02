import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, safeStorage, shell } from "electron";
import { OAuthClient, type UserInfo } from "@deyin/oauth-client";
import {
  FileTokenStore,
  beginDeepLinkLogin,
  loginWithLoopback,
  type DeepLinkLoginStart,
} from "@deyin/oauth-client/node";
import { DEEP_LINK_REDIRECT_URI, type DeyinConfig } from "@deyin/contract";
import type { UserProfile } from "@deyin/contract";

/**
 * Owns the Openference session for the desktop app.
 *
 * Default sign-in uses the deep-link flow: open the browser to the hosted
 * hosted Openference authorize page, which (after login + consent) fires
 * `deyin://oauth/callback?code&state` back to the app; the OS routes that URL
 * here and we exchange the code with zero clicks in the app. When the custom
 * protocol cannot be registered (unpackaged `electron-vite dev`), we fall back
 * to the RFC 8252 loopback flow so development still works.
 *
 * Tokens persist via the OS keychain (Electron `safeStorage`) when available.
 */
export class AuthManager {
  private readonly client: OAuthClient;
  private pending: DeepLinkLoginStart | null = null;
  private onChange: (() => void) | null = null;
  /** Last profile seen from UserInfo, cached beside the credentials. */
  private readonly profilePath: string;
  /** OS-keychain cipher shared by the token store and the profile cache. */
  private readonly encryptSecret?: (plaintext: string) => string | Buffer;
  private readonly decryptSecret?: (ciphertext: Buffer) => string;

  constructor(
    config: DeyinConfig,
    private readonly deepLinkAvailable: boolean,
  ) {
    const credentialsPath = join(app.getPath("userData"), "credentials.json");
    const canEncrypt = safeStorage.isEncryptionAvailable();

    this.profilePath = join(app.getPath("userData"), "profile.json");
    this.encryptSecret = canEncrypt ? (plaintext) => safeStorage.encryptString(plaintext) : undefined;
    this.decryptSecret = canEncrypt ? (ciphertext) => safeStorage.decryptString(ciphertext) : undefined;

    const store = new FileTokenStore({
      path: credentialsPath,
      encrypt: this.encryptSecret,
      decrypt: this.decryptSecret,
    });

    this.client = new OAuthClient(
      { issuer: config.oauthIssuer, clientId: config.clientId, scopes: config.scopes },
      store,
    );
  }

  /** Register a callback fired whenever the session changes (login/logout). */
  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  /**
   * Start sign-in. With the deep-link scheme registered this opens the browser
   * and resolves later via `completeDeepLink`, so it returns null immediately
   * (the renderer waits for the `auth:changed` event). In dev fallback it runs
   * the blocking loopback flow and returns the profile directly.
   */
  async connect(): Promise<UserProfile | null> {
    if (this.deepLinkAvailable) {
      this.pending = await beginDeepLinkLogin(this.client, { redirectUri: DEEP_LINK_REDIRECT_URI });
      // Electron's opener passes the URL to the OS intact; the generic
      // spawn-based helper went through cmd on Windows, which truncated the
      // query string at the first "&".
      void shell.openExternal(this.pending.authorizationUrl);
      return null;
    }
    await loginWithLoopback(this.client, {
      onAuthUrl: (url) => console.log("[deyin auth] authorize:", url),
    });
    this.onChange?.();
    return this.getUser();
  }

  /** Handle a `deyin://oauth/callback?...` URL routed from the OS. */
  async completeDeepLink(callbackUrl: string): Promise<void> {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    try {
      await pending.complete(callbackUrl);
      this.onChange?.();
    } catch (err) {
      console.error("[deyin auth] deep-link login failed:", err);
    }
  }

  async logout(): Promise<void> {
    await this.client.logout();
    await rm(this.profilePath, { force: true });
    this.onChange?.();
  }

  /**
   * The signed-in profile, or null when signed out.
   *
   * A UserInfo call that throws is not evidence of a signed-out user: right
   * after a machine boots the app usually wins the race against the network,
   * and treating that as "signed out" sent people back to the sign-in screen
   * on a session that was still valid. Only a session the OAuth client has
   * actually discarded (a rejected refresh token) reports null; otherwise the
   * last known profile stands in until the next call succeeds.
   */
  async getUser(): Promise<UserProfile | null> {
    if (!(await this.client.isAuthenticated())) {
      await rm(this.profilePath, { force: true });
      return null;
    }
    try {
      const profile = this.toProfile(await this.client.getUser());
      await this.cacheProfile(profile);
      return profile;
    } catch (err) {
      if (!(await this.client.isAuthenticated())) return null;
      const cached = await this.loadCachedProfile();
      if (!cached) return null;
      console.warn(
        "[deyin auth] userinfo unreachable, using the cached profile:",
        err instanceof Error ? err.message : String(err),
      );
      return cached;
    }
  }

  private async loadCachedProfile(): Promise<UserProfile | null> {
    try {
      const raw = await readFile(this.profilePath);
      const json = this.decryptSecret ? this.decryptSecret(raw) : raw.toString("utf8");
      return JSON.parse(json) as UserProfile;
    } catch {
      return null;
    }
  }

  private async cacheProfile(profile: UserProfile): Promise<void> {
    const json = JSON.stringify(profile);
    const data = this.encryptSecret ? this.encryptSecret(json) : json;
    const tmp = `${this.profilePath}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, this.profilePath);
    } catch (err) {
      await rm(tmp, { force: true });
      console.warn(
        "[deyin auth] could not cache the profile:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** A valid access token (auto-refreshed), or null if signed out. */
  async getAccessToken(): Promise<string | null> {
    if (!(await this.client.isAuthenticated())) return null;
    try {
      return await this.client.getAccessToken();
    } catch (err) {
      // Swallowing refresh errors here makes an expired session indistinguishable
      // from "signed out" upstream; log so the failure stays diagnosable.
      console.error("[deyin auth] access-token refresh failed:", err);
      return null;
    }
  }

  private toProfile(user: UserInfo): UserProfile {
    return {
      sub: user.sub,
      email: user.email,
      name: user.name,
      picture: user.picture,
      plan: user.plan,
    };
  }
}
