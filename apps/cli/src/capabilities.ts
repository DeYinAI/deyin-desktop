import { homedir } from "node:os";
import {
  matchCommand,
  resolveCommandInvocation,
  scanCapabilities,
  unknownCommandMessage,
  type CapabilitySnapshot,
} from "@deyin/agent-core";

/** Scan workspace + user capabilities for the CLI cwd. */
export async function loadCliCapabilities(cwd: string): Promise<CapabilitySnapshot> {
  return scanCapabilities({ cwd, userDir: homedir() });
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
