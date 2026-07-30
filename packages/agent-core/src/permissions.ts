import type { ToolDefinition, ToolPermissionTier } from "./types.js";

export type PermissionAction = "allow" | "ask" | "deny";

/** One rule: `tool` is a tool name or "*". Later rules win (opencode-style findLast). */
export interface PermissionRule {
  tool: string;
  action: PermissionAction;
}

export interface PermissionRequest {
  toolName: string;
  tier: ToolPermissionTier;
  args: Record<string, unknown>;
  /** Human one-liner, e.g. `bash: npm test`. */
  summary: string;
}

/** "allow-always" additionally grants the tool for the rest of the session. */
export type PermissionDecision = "allow" | "allow-always" | "deny";

/** Asks the host UI (TUI dialog, or auto-deny in headless) to decide an "ask" action. */
export type PermissionResolver = (req: PermissionRequest) => Promise<PermissionDecision>;

function tierDefault(tier: ToolPermissionTier): PermissionAction {
  if (tier === "read" || tier === "interaction") return "allow";
  return "ask";
}

export interface PermissionEngineOptions {
  /** Agent-level overrides (e.g. the plan agent denies write/edit). */
  agentRules?: PermissionRule[];
  /** User config rules (global + project deyin.json). Override agent rules. */
  configRules?: PermissionRule[];
  /** --yes / -y: skip every prompt and allow everything (headless/CI). */
  skipAll?: boolean;
}

/**
 * Three-tier permission merge: built-in tier defaults -> agent rules -> user config
 * rules, evaluated last-writer-wins, plus session "always allow" grants on top.
 */
export class PermissionEngine {
  private readonly rules: PermissionRule[];
  private readonly skipAll: boolean;
  private readonly sessionGrants = new Set<string>();

  constructor(opts: PermissionEngineOptions = {}) {
    this.rules = [...(opts.agentRules ?? []), ...(opts.configRules ?? [])];
    this.skipAll = opts.skipAll ?? false;
  }

  actionFor(tool: Pick<ToolDefinition, "name" | "tier">): PermissionAction {
    if (this.skipAll) return "allow";
    const match = this.rules.findLast((r) => r.tool === "*" || r.tool === tool.name);
    const action = match?.action ?? tierDefault(tool.tier);
    if (action === "deny") return "deny";
    if (action === "ask" && this.sessionGrants.has(tool.name)) return "allow";
    return action;
  }

  /** Session-scoped "always allow" (the "don't ask again" choice in the prompt). */
  grantForSession(toolName: string): void {
    this.sessionGrants.add(toolName);
  }

  listSessionGrants(): string[] {
    return [...this.sessionGrants];
  }
}
