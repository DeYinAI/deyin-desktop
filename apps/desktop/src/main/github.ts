import { safeStorage, shell } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GitHubAuthState, GitHubRepoEntry } from "@deyin/contract";

const GITHUB_CLIENT_ID = process.env.DEYIN_GITHUB_CLIENT_ID ?? "Ov23liPLACEHOLDER";
const TOKEN_PATH = join(homedir(), ".deyin", "github-token.json");

interface StoredToken {
  cipher: string;
  login: string;
}

function encryptToken(token: string): string {
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(token).toString("base64");
  return `plain:${Buffer.from(token, "utf8").toString("base64")}`;
}

function decryptToken(cipher: string): string {
  if (cipher.startsWith("plain:")) return Buffer.from(cipher.slice(6), "base64").toString("utf8");
  return safeStorage.decryptString(Buffer.from(cipher, "base64"));
}

/** GitHub OAuth + repo listing for the project picker. */
export class GitHubService {
  private token: string | null = null;
  private login: string | null = null;

  constructor() {
    this.loadStored();
  }

  private loadStored(): void {
    if (!existsSync(TOKEN_PATH)) return;
    try {
      const raw = JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as StoredToken;
      this.token = decryptToken(raw.cipher);
      this.login = raw.login;
    } catch {
      this.token = null;
      this.login = null;
    }
  }

  private persist(): void {
    mkdirSync(join(homedir(), ".deyin"), { recursive: true, mode: 0o700 });
    if (!this.token || !this.login) {
      if (existsSync(TOKEN_PATH)) writeFileSync(TOKEN_PATH, "{}");
      return;
    }
    writeFileSync(TOKEN_PATH, JSON.stringify({ cipher: encryptToken(this.token), login: this.login }, null, 2), {
      mode: 0o600,
    });
  }

  authState(): GitHubAuthState {
    return { connected: Boolean(this.token), login: this.login };
  }

  async connect(): Promise<GitHubAuthState> {
    const deviceRes = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "repo read:user" }),
    });
    if (!deviceRes.ok) throw new Error("Failed to start GitHub authorization.");
    const device = (await deviceRes.json()) as {
      device_code: string;
      verification_uri: string;
      interval: number;
      expires_in: number;
    };
    await shell.openExternal(device.verification_uri);
    const deadline = Date.now() + device.expires_in * 1000;
    while (Date.now() < deadline) {
      await sleep(device.interval * 1000);
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const body = (await tokenRes.json()) as { access_token?: string; error?: string };
      if (body.access_token) {
        this.token = body.access_token;
        const userRes = await this.api<{ login: string }>("/user");
        this.login = userRes.login;
        this.persist();
        return this.authState();
      }
      if (body.error !== "authorization_pending") {
        throw new Error(body.error ?? "GitHub authorization failed.");
      }
    }
    throw new Error("GitHub authorization timed out.");
  }

  disconnect(): void {
    this.token = null;
    this.login = null;
    this.persist();
  }

  async listRepos(query?: string): Promise<GitHubRepoEntry[]> {
    if (!this.token) throw new Error("Connect to GitHub first.");
    const q = query?.trim();
    const path = q
      ? `/search/repositories?q=${encodeURIComponent(q)}+in:name&per_page=30`
      : "/user/repos?per_page=50&sort=updated";
    const data = await this.api<{ items?: GitHubApiRepo[] } | GitHubApiRepo[]>(path);
    const repos = Array.isArray(data) ? data : (data.items ?? []);
    return repos.map(mapRepo);
  }

  getToken(): string | null {
    return this.token;
  }

  private async api<T>(path: string): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API error: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }
}

interface GitHubApiRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  clone_url: string;
  default_branch: string;
  description: string | null;
}

function mapRepo(r: GitHubApiRepo): GitHubRepoEntry {
  return {
    id: r.id,
    fullName: r.full_name,
    name: r.name,
    owner: r.owner.login,
    private: r.private,
    cloneUrl: r.clone_url,
    defaultBranch: r.default_branch,
    description: r.description,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
