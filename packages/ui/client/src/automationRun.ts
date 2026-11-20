import type { AutomationOutcome, AutomationRun } from "@deyin/contract";
import { formatDuration, runTimeline, type MessageKey } from "@deyin/host-core/shared";
import { fill } from "./automationFormat.js";

type Translate = (key: MessageKey) => string;

export function outcomeKey(outcome: AutomationOutcome): MessageKey {
  switch (outcome) {
    case "success":
      return "automations.outcome.success";
    case "idle":
      return "automations.outcome.idle";
    case "blocked":
      return "automations.outcome.blocked";
    case "failed":
      return "automations.outcome.failed";
    case "unreported":
      return "automations.outcome.unreported";
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

/**
 * "12 tool calls · 1 failed · 3m 20s". Counters come from the run's summary, which
 * survives history trimming; a run recorded before summaries existed is counted
 * from whatever events it kept.
 */
export function runFacts(run: AutomationRun, t: Translate): string {
  const timeline = run.summary ? null : runTimeline(run.events);
  const calls = run.summary?.steps ?? timeline?.length ?? 0;
  const failed = run.summary?.toolErrors ?? timeline?.filter((r) => r.state === "error").length ?? 0;
  const duration = run.summary?.durationMs ?? (run.finishedAt !== undefined ? run.finishedAt - run.startedAt : undefined);
  const parts: string[] = [];
  if (calls > 0) parts.push(fill(t("automations.records.toolCalls"), { count: calls }));
  if (failed > 0) parts.push(fill(t("automations.records.toolErrors"), { count: failed }));
  if (duration !== undefined) parts.push(formatDuration(duration));
  return parts.join(" · ");
}
