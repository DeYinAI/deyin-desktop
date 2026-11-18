import type {
  Automation,
  AutomationPayload,
  AutomationTarget,
} from "@deyin/contract";
import type { MessageKey } from "@deyin/host-core/shared";
import {
  defaultSchedule,
  scheduleIssue,
  scheduleToTrigger,
  triggerToSchedule,
  type ScheduleDraft,
} from "./automationSchedule.js";

export type PayloadKind = AutomationPayload["kind"];
export type TargetKind = AutomationTarget["kind"];

/**
 * A flat editing shape. The payload fields sit side by side rather than in a union so
 * switching kind back and forth does not lose what the user already typed.
 */
export interface AutomationDraft {
  name: string;
  description: string;
  payloadKind: PayloadKind;
  prompt: string;
  skill: string;
  subagent: string;
  capabilityInput: string;
  schedule: ScheduleDraft;
  targetKind: TargetKind;
  workspacePath: string;
  hostId: string;
  distro: string;
  model: string;
  providerId: string;
  enabled: boolean;
}

export type DraftField = "name" | "prompt" | "skill" | "subagent" | "workspacePath" | "hostId" | "distro" | "schedule";

export function emptyDraft(workspacePath: string, model: string, providerId: string, now?: Date): AutomationDraft {
  return {
    name: "",
    description: "",
    payloadKind: "prompt",
    prompt: "",
    skill: "",
    subagent: "",
    capabilityInput: "",
    schedule: defaultSchedule(now),
    targetKind: "local",
    workspacePath,
    hostId: "",
    distro: "",
    model,
    providerId,
    enabled: true,
  };
}

export function draftFromAutomation(a: Automation, now?: Date): AutomationDraft {
  return {
    name: a.name,
    description: a.description ?? "",
    payloadKind: a.payload.kind,
    prompt: a.payload.kind === "prompt" ? a.payload.prompt : "",
    skill: a.payload.kind === "skill" ? a.payload.skill : "",
    subagent: a.payload.kind === "subagent" ? a.payload.subagent : "",
    capabilityInput: a.payload.kind === "prompt" ? "" : (a.payload.input ?? ""),
    schedule: triggerToSchedule(a.trigger, now),
    targetKind: a.target.kind,
    workspacePath: a.target.workspacePath,
    hostId: a.target.kind === "ssh" ? a.target.hostId : "",
    distro: a.target.kind === "wsl" ? a.target.distro : "",
    model: a.model,
    providerId: a.providerId,
    enabled: a.enabled,
  };
}

function draftPayload(draft: AutomationDraft): AutomationPayload {
  const input = draft.capabilityInput.trim() || undefined;
  if (draft.payloadKind === "skill") return { kind: "skill", skill: draft.skill, input };
  if (draft.payloadKind === "subagent") return { kind: "subagent", subagent: draft.subagent, input };
  return { kind: "prompt", prompt: draft.prompt };
}

function draftTarget(draft: AutomationDraft): AutomationTarget {
  if (draft.targetKind === "ssh") return { kind: "ssh", hostId: draft.hostId, workspacePath: draft.workspacePath };
  if (draft.targetKind === "wsl") return { kind: "wsl", distro: draft.distro, workspacePath: draft.workspacePath };
  return { kind: "local", workspacePath: draft.workspacePath };
}

export function draftToAutomationInput(draft: AutomationDraft): Omit<Automation, "id" | "createdAt" | "updatedAt"> {
  // Out-of-process targets drive the deyin CLI, which only speaks Openference.
  const providerId = draft.targetKind === "local" ? draft.providerId : "openference";
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    payload: draftPayload(draft),
    trigger: scheduleToTrigger(draft.schedule),
    target: draftTarget(draft),
    model: draft.model,
    providerId,
    enabled: draft.enabled,
  };
}

/** Every problem that blocks saving, keyed by the field it belongs to, as translation keys. */
export function draftIssues(draft: AutomationDraft, now?: number): Partial<Record<DraftField, MessageKey>> {
  const issues: Partial<Record<DraftField, MessageKey>> = {};
  if (!draft.name.trim()) issues.name = "automations.issue.incomplete";
  if (draft.payloadKind === "prompt" && !draft.prompt.trim()) issues.prompt = "automations.err.prompt";
  if (draft.payloadKind === "skill" && !draft.skill) issues.skill = "automations.err.skill";
  if (draft.payloadKind === "subagent" && !draft.subagent) issues.subagent = "automations.err.subagent";
  if (!draft.workspacePath.trim()) issues.workspacePath = "automations.err.workspace";
  if (draft.targetKind === "ssh" && !draft.hostId) issues.hostId = "automations.err.host";
  if (draft.targetKind === "wsl" && !draft.distro) issues.distro = "automations.err.distro";
  const schedule = scheduleIssue(draft.schedule, now);
  if (schedule) issues.schedule = `automations.issue.${schedule}`;
  return issues;
}

/** Has the user changed anything from `base`? Compared through the stored shape, so equal schedules match. */
export function draftChanged(draft: AutomationDraft, base: AutomationDraft): boolean {
  const shape = (d: AutomationDraft) => ({ ...draftToAutomationInput(d), enabled: undefined });
  return JSON.stringify(shape(draft)) !== JSON.stringify(shape(base));
}
