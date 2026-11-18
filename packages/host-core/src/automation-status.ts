import type { Automation } from "./types.js";

/** Lifecycle shown in the automation list: running on schedule, switched off, or a finished one-shot. */
export type AutomationStatus = "active" | "paused" | "ended";

/** A one-shot automation is ended once its single slot has been claimed by a run. */
export function isAutomationEnded(automation: Pick<Automation, "trigger" | "lastScheduledAt">): boolean {
  return automation.trigger.kind === "once" && automation.lastScheduledAt !== undefined;
}

export function automationStatus(automation: Pick<Automation, "enabled" | "trigger" | "lastScheduledAt">): AutomationStatus {
  if (isAutomationEnded(automation)) return "ended";
  return automation.enabled ? "active" : "paused";
}
