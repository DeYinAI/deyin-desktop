/**
 * Deterministic planner routing (no classifier model).
 * Inspired by DeepSeek-Reasonix planner_route + planner_gate patterns.
 */

import type { PlannerDecision, PlannerDepth, PlannerRoute } from "./coordinator.js";

export interface RoutingContext {
  userMessage: string;
  isPlanMode: boolean;
  isAskMode: boolean;
  isSlashCommand: boolean;
  /** Short contextual reply (e.g. "yes", "continue", "looks good"). */
  isContextualReply: boolean;
  /** Single-file atomic edit indicators. */
  isAtomicEdit: boolean;
  /** Estimated number of files referenced or implied. */
  fileCount: number;
  hasAmbiguousScope: boolean;
  /** High-risk keywords (security, migration, delete, etc.). */
  isHighRisk: boolean;
  /** Active goal mode upgrades non-atomic work to planning. */
  hasActiveGoal: boolean;
}

const PLAN_FIRST_RE = /\b(plan\s+first|plan\s+before|show\s+me\s+a\s+plan|need\s+a\s+plan)\b/i;
const PLAN_ONLY_RE = /\b(just\s+plan|only\s+plan|plan\s+only|research\s+only|don't\s+implement|do\s+not\s+implement)\b/i;
const MULTI_FILE_RE = /\b(refactor|across\s+(the\s+)?(codebase|project|repo)|multiple\s+files|all\s+files|every\s+file|migrate|rename\s+everywhere)\b/i;
const AMBIGUOUS_RE = /\b(or|either|not\s+sure|unclear|ambiguous|which\s+approach|what\s+should\s+i|help\s+me\s+decide)\b/i;
const HIGH_RISK_RE = /\b(delete|drop\s+table|migration|security|auth|permission|production|breaking\s+change|database)\b/i;
const ATOMIC_EDIT_RE = /\b(fix\s+typo|rename\s+\w+|update\s+import|change\s+line|add\s+comment|bump\s+version)\b/i;
const CONTEXTUAL_REPLY_RE = /^(yes|no|ok|okay|sure|continue|go\s+ahead|approved|lgtm|looks\s+good|sounds\s+good|proceed)[.!?\s]*$/i;

/** Count explicit file paths in the message. */
export function countReferencedFiles(message: string): number {
  const backtickPaths = message.match(/`[^`]+\.(tsx?|jsx?|json|md|css|html|py|go|rs|yaml|yml|toml)`/gi) ?? [];
  const slashPaths = message.match(/\b(?:[\w.-]+\/)+[\w.-]+\.\w{1,6}\b/g) ?? [];
  const unique = new Set([...backtickPaths, ...slashPaths].map((p) => p.replace(/`/g, "").toLowerCase()));
  return unique.size;
}

export function buildRoutingContext(
  userMessage: string,
  opts: {
    mode: "agent" | "plan" | "ask";
    isSlashCommand?: boolean;
    hasActiveGoal?: boolean;
  },
): RoutingContext {
  const trimmed = userMessage.trim();
  const fileCount = countReferencedFiles(trimmed);
  return {
    userMessage: trimmed,
    isPlanMode: opts.mode === "plan",
    isAskMode: opts.mode === "ask",
    isSlashCommand: opts.isSlashCommand ?? trimmed.startsWith("/"),
    isContextualReply: CONTEXTUAL_REPLY_RE.test(trimmed) && trimmed.length < 80,
    isAtomicEdit: ATOMIC_EDIT_RE.test(trimmed) && fileCount <= 1 && trimmed.length < 200,
    fileCount,
    hasAmbiguousScope: AMBIGUOUS_RE.test(trimmed) || (fileCount === 0 && MULTI_FILE_RE.test(trimmed)),
    isHighRisk: HIGH_RISK_RE.test(trimmed),
    hasActiveGoal: opts.hasActiveGoal ?? false,
  };
}

function depthForRoute(route: PlannerRoute, ctx: RoutingContext): PlannerDepth {
  if (route === "executor_only") return "light";
  if (ctx.isHighRisk || ctx.fileCount > 5 || ctx.hasAmbiguousScope) return "full";
  if (ctx.fileCount > 2 || MULTI_FILE_RE.test(ctx.userMessage)) return "full";
  return "light";
}

function maxResearchRounds(depth: PlannerDepth): number {
  return depth === "full" ? 6 : 2;
}

export type CoordinatorRoutingPolicy = "balanced" | "conservative" | "aggressive";

const POLICY_THRESHOLDS: Record<
  CoordinatorRoutingPolicy,
  { fileCount: number; requireAmbiguous: boolean; requireMultiFile: boolean }
> = {
  balanced: { fileCount: 3, requireAmbiguous: false, requireMultiFile: true },
  conservative: { fileCount: 5, requireAmbiguous: false, requireMultiFile: false },
  aggressive: { fileCount: 2, requireAmbiguous: false, requireMultiFile: true },
};

/**
 * Analyze request and decide routing deterministically.
 */
export function routePlannerExecution(
  ctx: RoutingContext,
  policy: CoordinatorRoutingPolicy = "balanced",
): PlannerDecision {
  // Plan-only: research without execution
  if (PLAN_ONLY_RE.test(ctx.userMessage)) {
    return normalizeDecision({
      route: "plan_only",
      depth: "full",
      reason: "user_requested_plan_only",
    });
  }

  // Plan-for-approval: explicit user request
  if (PLAN_FIRST_RE.test(ctx.userMessage)) {
    return normalizeDecision({
      route: "plan_for_approval",
      depth: "full",
      reason: "user_requested_plan_first",
    });
  }

  // Executor-only shortcuts
  if (ctx.isPlanMode || ctx.isAskMode || ctx.isSlashCommand || ctx.isContextualReply || ctx.isAtomicEdit) {
    return normalizeDecision({
      route: "executor_only",
      depth: "light",
      reason: ctx.isPlanMode
        ? "explicit_plan_mode"
        : ctx.isAskMode
          ? "ask_mode"
          : ctx.isSlashCommand
            ? "slash_command"
            : ctx.isContextualReply
              ? "contextual_reply"
              : "atomic_edit",
    });
  }

  // Multi-file, ambiguous, high-risk, or goal-mode mutations → plan-and-execute
  const thresholds = POLICY_THRESHOLDS[policy] ?? POLICY_THRESHOLDS.balanced;
  const multiFileSignal = thresholds.requireMultiFile ? MULTI_FILE_RE.test(ctx.userMessage) : false;
  const ambiguousSignal = thresholds.requireAmbiguous ? ctx.hasAmbiguousScope : ctx.hasAmbiguousScope;
  const needsPlanning =
    ctx.fileCount > thresholds.fileCount ||
    ambiguousSignal ||
    ctx.isHighRisk ||
    multiFileSignal ||
    MULTI_FILE_RE.test(ctx.userMessage) ||
    (ctx.hasActiveGoal && !ctx.isAtomicEdit);

  if (needsPlanning) {
    const depth = depthForRoute("plan_and_execute", ctx);
    return normalizeDecision({
      route: "plan_and_execute",
      depth,
      reason:
        ctx.isHighRisk
          ? "high_risk_work"
          : ctx.hasAmbiguousScope
            ? "ambiguous_scope"
            : ctx.fileCount > 3
              ? "multi_file"
              : ctx.hasActiveGoal
                ? "active_goal"
                : "complex_task",
    });
  }

  return normalizeDecision({
    route: "executor_only",
    depth: "light",
    reason: "simple_request",
  });
}

function normalizeDecision(d: PlannerDecision): PlannerDecision {
  const route = d.route;
  if (route === "executor_only") {
    return { route, depth: "light", reason: d.reason, maxResearchRounds: 0 };
  }
  const depth = d.depth === "light" || d.depth === "full" ? d.depth : "full";
  return {
    route,
    depth,
    reason: d.reason || "default",
    maxResearchRounds: d.maxResearchRounds ?? maxResearchRounds(depth),
  };
}

export { normalizeDecision as normalizePlannerDecision };
