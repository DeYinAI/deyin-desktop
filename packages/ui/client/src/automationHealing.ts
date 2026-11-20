import type { AutomationInfo, LearnedRevision } from "@deyin/contract";
import type { MessageKey } from "@deyin/host-core/shared";

/** How many past patches the panel lists; older ones stay on disk but are not what anyone is looking for. */
export const MAX_REVISIONS_SHOWN = 8;

export interface RevisionView {
  id: string;
  at: number;
  rationale: string;
  added: readonly string[];
  removed: readonly string[];
  statusKey: MessageKey;
  /** Reverting also undoes every later patch, so only a patch that is still in effect offers it. */
  canRevert: boolean;
  note?: string;
}

export interface HealingView {
  enabled: boolean;
  rules: readonly string[];
  /** Newest first. */
  revisions: readonly RevisionView[];
  /** Whether there is anything to show beyond the switch. */
  hasHistory: boolean;
}

export function revisionStatusKey(status: LearnedRevision["status"]): MessageKey {
  switch (status) {
    case "probation":
      return "automations.healing.status.probation";
    case "kept":
      return "automations.healing.status.kept";
    case "reverted":
      return "automations.healing.status.reverted";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

/** What the Healing section shows for a saved automation; healing is on unless it was turned off. */
export function healingView(task: AutomationInfo): HealingView {
  const rules = task.learnedRules ?? [];
  const revisions = [...(task.learnedRevisions ?? [])]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_REVISIONS_SHOWN)
    .map((revision) => ({
      id: revision.id,
      at: revision.at,
      rationale: revision.rationale,
      added: revision.added,
      removed: revision.removed,
      statusKey: revisionStatusKey(revision.status),
      canRevert: revision.status !== "reverted",
      ...(revision.note ? { note: revision.note } : {}),
    }));
  return { enabled: task.autoHeal !== false, rules, revisions, hasHistory: rules.length > 0 || revisions.length > 0 };
}
