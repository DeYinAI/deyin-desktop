import {
  EMPTY_PERMISSIONS,
  createToolGate,
  type BotApprovalMode,
  type BotPermissionSettings,
  type PersonAnswer,
  type ReviewClassifier,
  type ReviewedCall,
} from "@deyin/host-core";

/** What the run needs from the saved permission settings. */
export interface GuardPermissions {
  get(): BotPermissionSettings;
  rememberAlways(toolName: string): unknown;
}

/** A card shown to the person: what the Bot wants to do, and why it needs a yes. */
export interface ApprovalRequest {
  toolName: string;
  summary: string;
  reason: string;
}

export interface BotToolGuardDeps {
  /** The Bot's approval mode, read for every call so a change applies at once. */
  mode: () => BotApprovalMode;
  permissions: GuardPermissions;
  /** A tool's permission tier, from the run's registry. Unknown tools are treated as able to change things. */
  tierOf: (toolName: string) => string | undefined;
  classify?: ReviewClassifier;
  /** Ask the person. Left out for runs nobody is watching: whatever needs a person is refused. */
  ask?: (request: ApprovalRequest) => Promise<PersonAnswer>;
  /** Shown on the card in place of the bare tool name, e.g. when a subagent is the one asking. */
  nameFor?: (toolName: string) => string;
}

export type ToolGuard = (
  call: { name: string },
  args: Record<string, unknown>,
  summary: string,
) => Promise<{ block: string } | undefined>;

/**
 * The agent loop's `beforeTool` hook for a Bot's run. It never throws and never fails open: the loop treats
 * a hook that throws as no objection, so anything unexpected here becomes a refusal instead.
 */
export function createBotToolGuard(deps: BotToolGuardDeps): ToolGuard {
  const gate = createToolGate({
    mode: deps.mode,
    settings: () => deps.permissions.get(),
    classify: deps.classify,
    ask: deps.ask
      ? (call, decision) =>
          deps.ask!({ toolName: deps.nameFor?.(call.name) ?? call.name, summary: call.summary, reason: decision.reason })
      : undefined,
    remember: (toolName) => void deps.permissions.rememberAlways(toolName),
  });

  return async (call, args, summary) => {
    try {
      const reviewed: ReviewedCall = { name: call.name, tier: deps.tierOf(call.name), summary, args };
      const outcome = await gate(reviewed);
      return outcome.allow ? undefined : { block: outcome.reason ?? "This Bot may not do that." };
    } catch {
      return { block: "Permissions could not be checked, so this was not done." };
    }
  };
}

/**
 * A Bot's approval mode, read when a call is made. A Bot that has gone missing mid-run is held to read-only,
 * the safest mode, rather than to whatever it last had.
 */
export function botModeOf(store: { get(id: string): { autoReview: { approvalMode: BotApprovalMode } } | undefined }, botId: string): BotApprovalMode {
  return store.get(botId)?.autoReview.approvalMode ?? "read_only";
}

/** What a Bot is held to when no saved settings were given: the built-in defaults, with nothing saved. */
export function defaultGuardPermissions(): GuardPermissions {
  return { get: () => EMPTY_PERMISSIONS, rememberAlways: () => undefined };
}
