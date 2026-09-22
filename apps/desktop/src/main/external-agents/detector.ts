import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { ExternalAgentDescriptor, ExternalAgentType } from "@deyin/contract";

const execFileAsync = promisify(execFile);

interface KnownAgentTarget {
  id: string;
  type: ExternalAgentType;
  name: string;
  binaryCandidates: string[];
  protocol: "acp" | "headless-cli";
  versionArgs: string[];
  defaultModels: string[];
  detectAuth: (home: string) => { authStatus: "authenticated" | "unauthenticated" | "unknown"; account?: string };
}

const KNOWN_AGENTS: KnownAgentTarget[] = [
  {
    id: "claude",
    type: "claude",
    name: "Claude Code",
    binaryCandidates: ["claude"],
    protocol: "headless-cli",
    versionArgs: ["--version"],
    defaultModels: ["claude-4.6-sonnet", "claude-4.5-opus", "claude-3-7-sonnet", "claude-3-5-haiku"],
    detectAuth: (home) => {
      const paths = [join(home, ".claude.json"), join(home, ".claude", "config.json"), join(home, ".claude", "auth.json")];
      for (const p of paths) {
        if (existsSync(p)) {
          try {
            const content = readFileSync(p, "utf8");
            if (content.includes("token") || content.includes("session") || content.includes("oauth") || content.includes("apiKey")) {
              return { authStatus: "authenticated", account: "Claude Pro / Account" };
            }
          } catch {}
        }
      }
      return { authStatus: "unknown" };
    },
  },
  {
    id: "codex",
    type: "codex",
    name: "OpenAI Codex CLI",
    binaryCandidates: ["codex"],
    protocol: "headless-cli",
    versionArgs: ["--version"],
    defaultModels: ["gpt-5.3-codex", "gpt-5-codex", "o3-mini", "gpt-4o"],
    detectAuth: (home) => {
      const paths = [join(home, ".codex", "config.json"), join(home, ".codex", "auth.json"), join(home, ".config", "codex", "config.json")];
      for (const p of paths) {
        if (existsSync(p)) {
          try {
            const content = readFileSync(p, "utf8");
            if (content.includes("token") || content.includes("api_key") || content.includes("session")) {
              return { authStatus: "authenticated", account: "ChatGPT Plus / Team" };
            }
          } catch {}
        }
      }
      return { authStatus: "unknown" };
    },
  },
  {
    id: "opencode",
    type: "opencode",
    name: "OpenCode AI Agent",
    binaryCandidates: ["opencode"],
    protocol: "acp",
    versionArgs: ["--version"],
    defaultModels: ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o", "local/llama3"],
    detectAuth: (home) => {
      const paths = [join(home, ".config", "opencode", "config.json"), join(home, ".opencode", "config.json")];
      for (const p of paths) {
        if (existsSync(p)) return { authStatus: "authenticated", account: "OpenCode Configured" };
      }
      return { authStatus: "authenticated", account: "Local / OSS" };
    },
  },
  {
    id: "zcode",
    type: "zcode",
    name: "ZCode / GLM Agent (Zed ACP)",
    binaryCandidates: ["zcode", "glm-acp-agent", "zed"],
    protocol: "acp",
    versionArgs: ["--version"],
    defaultModels: ["glm-5.3", "glm-5-turbo", "glm-4.7"],
    detectAuth: (home) => {
      const paths = [join(home, ".zcode", "config.json"), join(home, ".config", "zed", "settings.json")];
      for (const p of paths) {
        if (existsSync(p)) return { authStatus: "authenticated", account: "Z.ai GLM Coding Plan" };
      }
      return { authStatus: "unknown" };
    },
  },
  {
    id: "cursor",
    type: "cursor",
    name: "Cursor CLI",
    binaryCandidates: ["cursor"],
    protocol: "headless-cli",
    versionArgs: ["--version"],
    defaultModels: ["auto", "claude-4.6-sonnet", "gpt-5.3-codex"],
    detectAuth: () => ({ authStatus: "authenticated", account: "Cursor Subscription" }),
  },
];

/** Search directories to supplement PATH on various operating systems. */
function getExtraSearchPaths(): string[] {
  const home = homedir();
  const os = platform();
  const dirs: string[] = [];

  if (os === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    dirs.push(
      join(appData, "npm"),
      join(localAppData, "Programs"),
      join(home, "scoop", "shims"),
      "C:\\ProgramData\\chocolatey\\bin",
    );
  } else {
    dirs.push(
      "/usr/local/bin",
      "/opt/homebrew/bin",
      join(home, ".local", "bin"),
      join(home, ".cargo", "bin"),
      join(home, ".nvm", "current", "bin"),
    );
  }

  return dirs.filter((d) => existsSync(d));
}

/** Resolve full binary path if available. */
function resolveBinaryPath(name: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const extra = getExtraSearchPaths();
  const allDirs = [...pathEnv.split(delimiter), ...extra];
  const isWin = platform() === "win32";
  const exts = isWin ? [".cmd", ".exe", ".bat", ""] : [""];

  for (const dir of allDirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, `${name}${ext}`);
      if (existsSync(full)) {
        return full;
      }
    }
  }
  return null;
}

export class ExternalAgentDetector {
  private cache: ExternalAgentDescriptor[] | null = null;
  private lastScannedAt = 0;
  private readonly ttlMs = 60_000;

  async detectAll(forceRefresh = false): Promise<ExternalAgentDescriptor[]> {
    const now = Date.now();
    if (!forceRefresh && this.cache && now - this.lastScannedAt < this.ttlMs) {
      return this.cache;
    }

    const home = homedir();
    const results: ExternalAgentDescriptor[] = await Promise.all(
      KNOWN_AGENTS.map(async (target) => {
        let binaryPath: string | null = null;
        let matchedBinary = target.binaryCandidates[0]!;

        for (const candidate of target.binaryCandidates) {
          const resolved = resolveBinaryPath(candidate);
          if (resolved) {
            binaryPath = resolved;
            matchedBinary = candidate;
            break;
          }
        }

        if (!binaryPath) {
          return {
            id: target.id,
            type: target.type,
            name: target.name,
            binaryName: matchedBinary,
            installed: false,
            protocol: target.protocol,
            authStatus: "unknown",
            availableModels: target.defaultModels,
            lastCheckedAt: now,
          };
        }

        // Query version
        let version: string | undefined;
        try {
          const { stdout, stderr } = await execFileAsync(binaryPath, target.versionArgs, {
            timeout: 3000,
            windowsHide: true,
          });
          const raw = (stdout || stderr).split("\n")[0]?.trim();
          if (raw) version = raw;
        } catch {
          version = undefined;
        }

        const { authStatus, account } = target.detectAuth(home);

        return {
          id: target.id,
          type: target.type,
          name: target.name,
          binaryName: matchedBinary,
          installed: true,
          version,
          path: binaryPath,
          protocol: target.protocol,
          authStatus,
          authAccountName: account,
          availableModels: target.defaultModels,
          lastCheckedAt: now,
        };
      }),
    );

    this.cache = results;
    this.lastScannedAt = now;
    return results;
  }

  async testAgent(agentId: string): Promise<{ ok: boolean; message: string; version?: string }> {
    const all = await this.detectAll();
    const found = all.find((a) => a.id === agentId);
    if (!found) {
      return { ok: false, message: `Agent '${agentId}' is not recognized.` };
    }
    if (!found.installed || !found.path) {
      return { ok: false, message: `Executable for '${found.name}' was not found in PATH.` };
    }

    try {
      const target = KNOWN_AGENTS.find((k) => k.id === agentId);
      const args = target?.versionArgs ?? ["--version"];
      const { stdout, stderr } = await execFileAsync(found.path, args, {
        timeout: 4000,
        windowsHide: true,
      });
      const output = (stdout || stderr).trim();
      return { ok: true, message: `Successfully connected: ${output}`, version: found.version };
    } catch (err: any) {
      return { ok: false, message: `Failed to execute: ${err.message}` };
    }
  }
}
