import type { AgentMessage, WireTool } from "../types.js";
import type { AgentRunResult } from "../loop.js";
import {
  executorToolHandoffContext,
  formatHandoff,
  isNoOpPlan,
  requiresApproval,
} from "./handoff.js";
import { routePlannerExecution, type CoordinatorRoutingPolicy, type RoutingContext } from "./planner-router.js";
import { plannerMaxSteps } from "./planner-agent.js";

export type PlannerRoute = "executor_only" | "plan_and_execute" | "plan_for_approval" | "plan_only";
export type PlannerDepth = "light" | "full";

export interface PlannerDecision {
  route: PlannerRoute;
  depth: PlannerDepth;
  reason: string;
  maxResearchRounds?: number;
}

export interface CoordinatorPhaseEvent {
  phase: "routing" | "planning" | "executing" | "persisted" | "fallback";
  detail?: string;
}

export interface PlannerRunResult {
  plan: string;
  ok: boolean;
  error?: string;
}

export interface CoordinatorRunCallbacks {
  /** Run the planner agent with isolated session messages. */
  runPlanner: (input: {
    userMessage: string;
    plannerMessages: AgentMessage[];
    maxSteps: number;
  }) => Promise<PlannerRunResult>;
  /** Run the executor agent with isolated session messages. */
  runExecutor: (input: {
    userMessage: string;
    executorMessages: AgentMessage[];
  }) => Promise<AgentRunResult>;
  /** Executor tool schemas for handoff context block. */
  executorTools: WireTool[];
  onPhase?: (event: CoordinatorPhaseEvent) => void;
  onDecision?: (decision: PlannerDecision) => void;
  onMessage?: (session: "planner" | "executor", message: AgentMessage) => void;
}

export interface CoordinatorRunInput {
  userMessage: string;
  routingContext: RoutingContext;
  /** Override automatic routing. */
  decision?: PlannerDecision;
  /** Routing policy when decision is not provided. */
  routingPolicy?: import("./planner-router.js").CoordinatorRoutingPolicy;
}

export interface CoordinatorRunResult {
  decision: PlannerDecision;
  finalText: string;
  reason: AgentRunResult["reason"];
  plannerUsed: boolean;
  executorOnly: boolean;
}

/**
 * Two-model planner/executor coordination with isolated sessions.
 * Planner and executor never share transcripts to preserve cache stability.
 */
export class Coordinator {
  private plannerSession: AgentMessage[] = [];
  /** Shared with host — same array as the executor transcript. */
  private executorSession: AgentMessage[];

  constructor(
    private readonly plannerSystemPrompt: string,
    executorMessages: AgentMessage[],
  ) {
    this.plannerSession = [{ role: "system", content: plannerSystemPrompt }];
    this.executorSession = executorMessages;
  }

  getPlannerSession(): readonly AgentMessage[] {
    return this.plannerSession;
  }

  getExecutorSession(): readonly AgentMessage[] {
    return this.executorSession;
  }

  resetPlannerSession(): void {
    this.plannerSession = [{ role: "system", content: this.plannerSystemPrompt }];
  }

  decidePlanning(context: RoutingContext, policy: CoordinatorRoutingPolicy = "balanced"): PlannerDecision {
    return routePlannerExecution(context, policy);
  }

  /**
   * Run coordinated turn: route → plan (optional) → execute (optional).
   */
  async run(input: CoordinatorRunInput, callbacks: CoordinatorRunCallbacks): Promise<CoordinatorRunResult> {
    const decision =
      input.decision ?? this.decidePlanning(input.routingContext, input.routingPolicy ?? "balanced");
    callbacks.onDecision?.(decision);
    callbacks.onPhase?.({ phase: "routing", detail: `${decision.route}:${decision.reason}` });

    if (decision.route === "executor_only") {
      callbacks.onPhase?.({ phase: "executing", detail: "executor_only" });
      return this.runExecutorOnly(input.userMessage, decision, callbacks);
    }

    callbacks.onPhase?.({ phase: "planning", detail: decision.depth });
    let plan: string;
    try {
      const plannerResult = await this.runPlanner(input.userMessage, decision, callbacks);
      if (!plannerResult.ok) {
        callbacks.onPhase?.({ phase: "fallback", detail: plannerResult.error ?? "planner_failed" });
        return this.runExecutorOnly(input.userMessage, decision, callbacks, plannerResult.error);
      }
      plan = plannerResult.plan;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      callbacks.onPhase?.({ phase: "fallback", detail: msg });
      return this.runExecutorOnly(input.userMessage, decision, callbacks, msg);
    }

    if (isNoOpPlan(plan)) {
      this.persistExecutorNoOp(input.userMessage, plan, callbacks);
      callbacks.onPhase?.({ phase: "persisted", detail: "no_op" });
      return {
        decision,
        finalText: plan,
        reason: "completed",
        plannerUsed: true,
        executorOnly: false,
      };
    }

    if (decision.route === "plan_only") {
      this.persistExecutorNoOp(input.userMessage, plan, callbacks);
      callbacks.onPhase?.({ phase: "persisted", detail: "plan_only" });
      return {
        decision,
        finalText: plan,
        reason: "completed",
        plannerUsed: true,
        executorOnly: false,
      };
    }

    if (decision.route === "plan_for_approval" || requiresApproval(plan)) {
      this.persistExecutorNoOp(input.userMessage, `[Awaiting approval]\n\n${plan}`, callbacks);
      callbacks.onPhase?.({ phase: "persisted", detail: "plan_for_approval" });
      return {
        decision,
        finalText: plan,
        reason: "completed",
        plannerUsed: true,
        executorOnly: false,
      };
    }

    callbacks.onPhase?.({ phase: "executing", detail: "plan_and_execute" });
    const handoff = formatHandoff(
      input.userMessage,
      plan,
      executorToolHandoffContext(callbacks.executorTools),
    );
    const result = await this.runExecutorHandoff(handoff, callbacks);
    return {
      decision,
      finalText: result.finalText,
      reason: result.reason,
      plannerUsed: true,
      executorOnly: false,
    };
  }

  private async runPlanner(
    userMessage: string,
    decision: PlannerDecision,
    callbacks: CoordinatorRunCallbacks,
  ): Promise<PlannerRunResult> {
    const maxSteps = decision.maxResearchRounds ?? plannerMaxSteps(decision.depth);
    const plannerUser: AgentMessage = { role: "user", content: userMessage };
    this.plannerSession.push(plannerUser);
    callbacks.onMessage?.("planner", plannerUser);

    const result = await callbacks.runPlanner({
      userMessage,
      plannerMessages: this.plannerSession,
      maxSteps,
    });

    if (result.ok && result.plan.trim()) {
      const assistant: AgentMessage = { role: "assistant", content: result.plan };
      this.plannerSession.push(assistant);
      callbacks.onMessage?.("planner", assistant);
    }

    return result;
  }

  private async runExecutorHandoff(
    handoffMessage: string,
    callbacks: CoordinatorRunCallbacks,
  ): Promise<AgentRunResult> {
    const userMsg: AgentMessage = { role: "user", content: handoffMessage };
    this.executorSession.push(userMsg);
    callbacks.onMessage?.("executor", userMsg);

    const result = await callbacks.runExecutor({
      userMessage: handoffMessage,
      executorMessages: this.executorSession,
    });

    if (result.finalText.trim()) {
      const assistant: AgentMessage = { role: "assistant", content: result.finalText };
      this.executorSession.push(assistant);
      callbacks.onMessage?.("executor", assistant);
    }

    return result;
  }

  private appendExecutorUser(content: string, callbacks: CoordinatorRunCallbacks): void {
    const last = this.executorSession.at(-1);
    if (last?.role === "user" && last.content === content) return;
    const userMsg: AgentMessage = { role: "user", content };
    this.executorSession.push(userMsg);
    callbacks.onMessage?.("executor", userMsg);
  }

  private async runExecutorOnly(
    userMessage: string,
    decision: PlannerDecision,
    callbacks: CoordinatorRunCallbacks,
    plannerFailure?: string,
  ): Promise<CoordinatorRunResult> {
    const message =
      plannerFailure != null
        ? `${userMessage}\n\n[Note: planner pass failed (${plannerFailure}); proceeding executor-only.]`
        : userMessage;

    callbacks.onPhase?.({ phase: "executing", detail: plannerFailure ? "fallback" : "direct" });
    this.appendExecutorUser(message, callbacks);

    const result = await callbacks.runExecutor({
      userMessage: message,
      executorMessages: this.executorSession,
    });

    if (result.finalText.trim()) {
      const assistant: AgentMessage = { role: "assistant", content: result.finalText };
      this.executorSession.push(assistant);
      callbacks.onMessage?.("executor", assistant);
    }

    return {
      decision,
      finalText: result.finalText,
      reason: result.reason,
      plannerUsed: false,
      executorOnly: true,
    };
  }

  private persistExecutorNoOp(
    userMessage: string,
    plan: string,
    callbacks: CoordinatorRunCallbacks,
  ): void {
    this.appendExecutorUser(userMessage, callbacks);
    const assistant: AgentMessage = { role: "assistant", content: plan };
    this.executorSession.push(assistant);
    callbacks.onMessage?.("executor", assistant);
  }
}

