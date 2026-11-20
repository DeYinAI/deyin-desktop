import { PermissionEngine, ToolRegistry, runAgent } from "@deyin/agent-core";
import type { Automation, AutomationRun } from "@deyin/host-core";
import { resolveProviderRouting, type AgentRunContextDeps } from "./agent-run-context.js";
import { buildHealMessages, createProposalTool } from "./heal-prompt.js";
import type { Proposal } from "./healer.js";

/** A heal is a quick read of one failed run, not a task. */
const HEAL_MAX_STEPS = 3;
const HEAL_TIMEOUT_MS = 2 * 60_000;

/**
 * Asks the automation's own model what rule would have prevented this failure. It runs with one tool that
 * records a proposal and nothing else — no files, no shell, no browser — so even a hostile page copied into
 * the run's transcript has nothing to act with. Returns null when the model proposes nothing.
 */
export async function proposeLearnedRules(deps: AgentRunContextDeps, automation: Automation, run: AutomationRun): Promise<Proposal | null> {
  let proposal: Proposal | null = null;
  const tools = new ToolRegistry();
  tools.register(createProposalTool((p) => void (proposal = p)));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEAL_TIMEOUT_MS);
  const routing = resolveProviderRouting(deps, automation.providerId);
  try {
    await runAgent({
      apiBaseUrl: routing.apiBaseUrl,
      getToken: routing.getToken,
      model: automation.model,
      maxSteps: HEAL_MAX_STEPS,
      contextLength: deps.getContextLength(automation.providerId, automation.model),
      maxTokens: deps.getMaxOutputTokens?.(automation.providerId, automation.model),
      messages: buildHealMessages(automation, run),
      tools,
      permissions: new PermissionEngine({ agentRules: [], configRules: [], skipAll: false }),
      resolvePermission: async () => "deny",
      cwd: automation.target.workspacePath,
      thinking: false,
      signal: controller.signal,
      todoReconcile: false,
      goalReconcile: false,
    });
  } finally {
    clearTimeout(timer);
  }
  return proposal;
}
