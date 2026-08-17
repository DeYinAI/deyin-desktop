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
  /** Exact tool names that must never be auto-allowed by skipAll. */
  neverSkipTools?: Iterable<string>;
  /** Prefix patterns (e.g. "computer_") that must never be auto-allowed by skipAll. */
  neverSkipPrefixes?: Iterable<string>;
}

function matchesNeverSkip(
  toolName: string,
  neverSkipTools: Set<string>,
  neverSkipPrefixes: string[],
): boolean {
  if (neverSkipTools.has(toolName)) return true;
  return neverSkipPrefixes.some((prefix) => toolName.startsWith(prefix));
}

/**
 * Three-tier permission merge: built-in tier defaults -> agent rules -> user config
 * rules, evaluated last-writer-wins, plus session "always allow" grants on top.
 */
export class PermissionEngine {
  private readonly rules: PermissionRule[];
  private skipAll: boolean;
  private readonly neverSkipTools: Set<string>;
  private readonly neverSkipPrefixes: string[];
  private readonly sessionGrants = new Set<string>();

  constructor(opts: PermissionEngineOptions = {}) {
    this.rules = [...(opts.agentRules ?? []), ...(opts.configRules ?? [])];
    this.skipAll = opts.skipAll ?? false;
    this.neverSkipTools = new Set(opts.neverSkipTools ?? []);
    this.neverSkipPrefixes = [...(opts.neverSkipPrefixes ?? [])];
  }

  actionFor(tool: Pick<ToolDefinition, "name" | "tier">): PermissionAction {
    const protectedTool = matchesNeverSkip(tool.name, this.neverSkipTools, this.neverSkipPrefixes);
    const match = this.rules.findLast((r) => r.tool === "*" || r.tool === tool.name);
    const ruleAction = match?.action ?? tierDefault(tool.tier);
    if (ruleAction === "deny") return "deny";
    if (this.skipAll && !protectedTool) return "allow";
    if (ruleAction === "ask" && this.sessionGrants.has(tool.name) && !protectedTool) return "allow";
    return ruleAction;
  }

  /** Rebuild rules and skipAll after a mode switch mid-run. */
  reconfigure(opts: PermissionEngineOptions): void {
    this.rules.length = 0;
    this.rules.push(...(opts.agentRules ?? []), ...(opts.configRules ?? []));
    this.skipAll = opts.skipAll ?? false;
    this.neverSkipTools.clear();
    for (const t of opts.neverSkipTools ?? []) this.neverSkipTools.add(t);
    this.neverSkipPrefixes.length = 0;
    this.neverSkipPrefixes.push(...(opts.neverSkipPrefixes ?? []));
  }

  /** Session-scoped "always allow" (the "don't ask again" choice in the prompt). */
  grantForSession(toolName: string): void {
    this.sessionGrants.add(toolName);
  }

  listSessionGrants(): string[] {
    return [...this.sessionGrants];
  }
}
