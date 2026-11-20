import { createReviewClassifier, type ReviewModel, type ReviewRunner } from "./review-classifier.js";
import type { BotRunSource } from "./run.js";
import { botModeOf, createBotToolGuard, defaultGuardPermissions, type ApprovalRequest, type ToolGuard } from "./tool-guard.js";
import type { PersonAnswer } from "@deyin/host-core";

export interface BotRunGuardOptions {
  source: BotRunSource;
  botId: string;
  /** A tool's permission tier in this run's registry. */
  tierOf: (toolName: string) => string | undefined;
  /** The model that reviews: the one the run is on. */
  reviewer: ReviewModel;
  /** Ask the person. Left out for a run nobody is watching. */
  ask?: (request: ApprovalRequest) => Promise<PersonAnswer>;
  /** What the card calls the tool, e.g. when a subagent is the one asking. */
  nameFor?: (toolName: string) => string;
  /** Stands in for the reviewer's model in tests. */
  reviewRunner?: ReviewRunner;
}

/**
 * The `beforeTool` hook that holds one Bot run to the Bot's permissions: its approval mode, the saved tool
 * permissions, and the allow and block instructions applied by a reviewer on the run's own model.
 */
export function createBotRunGuard(options: BotRunGuardOptions): ToolGuard {
  return createBotToolGuard({
    mode: () => botModeOf(options.source.store, options.botId),
    permissions: options.source.permissions ?? defaultGuardPermissions(),
    tierOf: options.tierOf,
    classify: createReviewClassifier(options.reviewer, options.reviewRunner),
    ask: options.ask,
    nameFor: options.nameFor,
  });
}
