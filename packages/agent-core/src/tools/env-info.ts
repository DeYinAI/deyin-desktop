import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import type { ToolDefinition } from "../types.js";

const execFileAsync = promisify(execFile);

/** Env vars that never leak to the model, whatever their value. */
const SECRET_KEYS = /(key|token|secret|password|credential|cipher|auth)/i;

/** Whitelisted env vars worth telling the agent about (values are redacted per key). */
const SAFE_KEYS = ["HOME", "USER", "USERNAME", "SHELL", "TERM", "LANG", "LC_ALL", "PATH", "TMPDIR", "TEMP", "TMP", "CI", "DEYIN_AGENT"];

const TOOL_CHECKS = ["git", "node", "npm", "pnpm", "yarn", "python", "python3", "docker", "make", "cargo", "go", "rg"];

function redact(value: string): string {
  // Never print credential-shaped values even from whitelisted vars.
  if (SECRET_KEYS.test(value) || /sk-[A-Za-z0-9]{8,}/.test(value)) return "(redacted)";
  return value;
}

async function toolVersion(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(name, ["--version"], { timeout: 3000, windowsHide: true });
    return stdout.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Read-only environment snapshot: platform, shell, PATH, and which common
 * toolchains are installed (with versions). Values of anything that looks like
 * a secret are redacted by construction — this tool must never leak keys.
 */
export const envInfoTool: ToolDefinition = {
  name: "env_info",
  description:
    "Read-only environment summary: OS, shell, PATH and which toolchains (git, node, npm, pnpm, python, docker, ...) are installed with versions. Use before planning setup/install steps instead of guessing.",
  tier: "read",
  parameters: { type: "object", properties: {} },
  summarize: () => "environment summary",
  async execute(): Promise<string> {
    const lines: string[] = [];
    lines.push(`host: ${hostname()}`);
    lines.push(`platform: ${process.platform} (${process.arch})`);
    lines.push(`node: ${process.version}`);
    const cwd = process.cwd();
    lines.push(`cwd: ${cwd}`);
    for (const key of SAFE_KEYS) {
      const value = process.env[key];
      if (value !== undefined) lines.push(`${key}=${key === "PATH" ? value : redact(value)}`);
    }
    const available: string[] = [];
    const missing: string[] = [];
    await Promise.all(
      TOOL_CHECKS.map(async (name) => {
        const version = await toolVersion(name);
        if (version) available.push(`${name} ${version}`);
        else missing.push(name);
      }),
    );
    lines.push(`tools: ${available.length > 0 ? available.join(" · ") : "(none detected)"}`);
    lines.push(`not found: ${missing.join(", ")}`);
    return lines.join("\n");
  },
};
