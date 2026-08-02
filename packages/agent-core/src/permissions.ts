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
  /** --yes / -y: skip every prompt and allow everything, even explicit denies (headless/CI). */
  skipAll?: boolean;
  /**
   * Full-access mode: auto-allow every "ask" (no prompts) while explicit
   * "deny" rules still win, so the mode agents' write/edit denies stay
   * enforced (e.g. plan mode stays read-only for file changes). Unlike
   * `skipAll`, this never overrides a deny.
   */
  autoAllow?: boolean;
}

/**
 * Three-tier permission merge: built-in tier defaults -> agent rules -> user config
 * rules, evaluated last-writer-wins, plus session "always allow" grants on top.
 * `autoAllow` turns every "ask" into "allow" without touching denies; `skipAll`
 * (CLI --yes) allows everything outright.
 */
export class PermissionEngine {
  private readonly agentRules: PermissionRule[];
  private configRules: PermissionRule[];
  private readonly skipAll: boolean;
  private readonly autoAllow: boolean;
  private readonly sessionGrants = new Set<string>();

  constructor(opts: PermissionEngineOptions = {}) {
    this.agentRules = opts.agentRules ?? [];
    this.configRules = opts.configRules ?? [];
    this.skipAll = opts.skipAll ?? false;
    this.autoAllow = opts.autoAllow ?? false;
  }

  /** Replaces the user/mode config rules, e.g. after a mid-run mode switch. */
  setConfigRules(rules: PermissionRule[]): void {
    this.configRules = rules;
  }

  actionFor(tool: Pick<ToolDefinition, "name" | "tier">): PermissionAction {
    if (this.skipAll) return "allow";
    const rules = [...this.agentRules, ...this.configRules];
    const match = rules.findLast((r) => r.tool === "*" || r.tool === tool.name);
    const action = match?.action ?? tierDefault(tool.tier);
    if (action === "deny") return "deny";
    if (this.autoAllow) return "allow";
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
