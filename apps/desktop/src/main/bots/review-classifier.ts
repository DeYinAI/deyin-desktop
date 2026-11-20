import { PermissionEngine, ToolRegistry, runAgent, type ProviderApiFormat, type ToolDefinition } from "@deyin/agent-core";
import {
  REVIEW_TOOL_NAME,
  REVIEW_TOOL_SCHEMA,
  buildReviewPrompt,
  parseReviewVerdict,
  type ReviewClassifier,
  type ReviewVerdict,
} from "@deyin/host-core";

/** A review is one quick judgement on one action, not a task. */
const REVIEW_MAX_STEPS = 2;
export const REVIEW_TIMEOUT_MS = 30_000;

/** The model that reviews: the one the Bot is running on, reached the same way. */
export interface ReviewModel {
  apiBaseUrl: string;
  getToken: () => Promise<string | null>;
  apiFormat?: ProviderApiFormat;
  authHeader?: boolean;
  model: string;
  contextLength?: number;
  cwd: string;
}

/** `runAgent`, as far as a review uses it, so a test can stand in for the model. */
export type ReviewRunner = (options: Parameters<typeof runAgent>[0]) => Promise<unknown>;

/** The one tool the reviewer has. It records a verdict and does nothing else. The caller keeps the first one. */
export function createVerdictTool(record: (verdict: ReviewVerdict) => void): ToolDefinition {
  return {
    name: REVIEW_TOOL_NAME,
    description: "Give your verdict on the action under review. allow, ask or block, with a one-sentence reason.",
    tier: "read",
    parameters: { ...REVIEW_TOOL_SCHEMA, required: [...REVIEW_TOOL_SCHEMA.required] },
    summarize: () => "review verdict",
    execute: async (args) => {
      const verdict = parseReviewVerdict(args);
      if (!verdict) throw new Error("verdict must be allow, ask or block, and reason a string.");
      record(verdict);
      return "Recorded. You are done; do not take further actions.";
    },
  };
}

/**
 * Asks the Bot's model whether one action fits the person's own allow and block instructions. It runs with
 * the single verdict tool and no permission to do anything else, so an action's text, which may have come
 * from a web page or a message, has nothing to act with. No verdict, a timeout or a model error all reject,
 * which `decideToolUse` treats as "ask a person".
 */
export function createReviewClassifier(model: ReviewModel, run: ReviewRunner = runAgent, timeoutMs: number = REVIEW_TIMEOUT_MS): ReviewClassifier {
  return async (request) => {
    const given: { verdict: ReviewVerdict | null } = { verdict: null };
    const tools = new ToolRegistry();
    tools.register(createVerdictTool((v) => void (given.verdict ??= v)));
    const { system, user } = buildReviewPrompt(request);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await run({
        apiBaseUrl: model.apiBaseUrl,
        getToken: model.getToken,
        ...(model.apiFormat ? { apiFormat: model.apiFormat } : {}),
        ...(model.authHeader !== undefined ? { authHeader: model.authHeader } : {}),
        model: model.model,
        maxSteps: REVIEW_MAX_STEPS,
        contextLength: model.contextLength,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools,
        permissions: new PermissionEngine({ agentRules: [], configRules: [], skipAll: false }),
        resolvePermission: async () => "deny",
        cwd: model.cwd,
        thinking: false,
        signal: controller.signal,
        todoReconcile: false,
        goalReconcile: false,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!given.verdict) throw new Error("The reviewer gave no verdict.");
    return given.verdict;
  };
}
