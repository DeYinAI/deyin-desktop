import { homedir } from "node:os";
import { join } from "node:path";
import {
  materializeBuiltinSkills,
  matchCommand,
  resolveCommandInvocation,
  scanCapabilities,
  unknownCommandMessage,
  type McpServerDefinition,
  type CapabilitySnapshot,
} from "@deyin/agent-core";
import { defaultDataDir } from "@deyin/host-core";

export interface CliCapabilityOptions {
  cwd: string;
  /** CLI data root; defaults to ~/.deyin (or $DEYIN_DATA_DIR). */
  dataDir?: string;
  /** Explicit trust decision for workspace hooks and MCP configuration. */
  trustedWorkspace?: boolean;
}

/** Scan workspace + user capabilities for the CLI cwd. */
export async function loadCliCapabilities(input: string | CliCapabilityOptions): Promise<CapabilitySnapshot> {
  const opts = typeof input === "string" ? { cwd: input } : input;
  const dataDir = opts.dataDir ?? defaultDataDir();
  const builtinSkillsDir = join(dataDir, "builtin-skills");
  const pluginsDir = join(dataDir, "plugins");
  // Built-in skills are real SKILL.md files so the CLI resolves them through
  // the same capability path as user and plugin skills.
  try {
    materializeBuiltinSkills(builtinSkillsDir);
  } catch {
    // A read-only data directory must not make the CLI unusable.
  }
  const snapshot = await scanCapabilities({
    cwd: opts.cwd,
    userDir: homedir(),
    pluginsDir,
    builtinSkillsDir,
    trustedWorkspace: opts.trustedWorkspace === true,
  });
  if (opts.trustedWorkspace === true) return snapshot;
  // A cloned repository can ship hooks and MCP commands. Keep discovering them
  // for diagnostics, but do not execute workspace-owned definitions until the
  // caller explicitly trusts the workspace.
  return {
    ...snapshot,
    hooks: snapshot.hooks.filter((hook) => hook.source !== "workspace"),
    mcpServers: snapshot.mcpServers.filter((server) => server.source !== "workspace"),
  };
}

/** Merge discovered MCP definitions with the legacy config.json shape. */
export function cliMcpDefinitions(
  snapshot: CapabilitySnapshot,
  configured: Record<string, { command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }>,
): McpServerDefinition[] {
  const definitions = [...snapshot.mcpServers];
  for (const [name, server] of Object.entries(configured)) {
    if (definitions.some((entry) => entry.name === name)) continue;
    definitions.push({
      name,
      transport: "stdio",
      command: server.command,
      args: server.args,
      env: server.env,
      enabled: server.enabled !== false && Boolean(server.command),
      source: "config",
    });
  }
  return definitions;
}

export interface ResolvedCliPrompt {
  prompt: string;
  /** Set when the user typed an unknown "/name" command. */
  error?: string;
}

/**
 * Expand slash commands and skills into model prompts. Built-in CLI commands
 * (/help, /goal, …) are handled by the TUI before this runs.
 */
export function resolveCliPrompt(text: string, caps: CapabilitySnapshot): ResolvedCliPrompt {
  const invocation = matchCommand(text);
  if (invocation?.name === "goal") {
    const args = invocation.args.trim();
    return { prompt: args || "What should I work on next?" };
  }
  const resolved = resolveCommandInvocation(text, caps);
  if (resolved.kind === "unknown") {
    return { prompt: text, error: unknownCommandMessage(resolved.name, resolved.suggestions) };
  }
  if (resolved.kind === "command" || resolved.kind === "skill") {
    return { prompt: resolved.prompt };
  }
  return { prompt: text };
}
