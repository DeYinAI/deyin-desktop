import type { BotResult, DeyinApi } from "@deyin/contract";
import {
  BOT_APPROVAL_MODES,
  LOCAL_SCOPE,
  PERMISSION_LIMITS,
  TOOL_PERMISSIONS,
  type BotApprovalMode,
  type BotPermissionSettings,
  type MessageKey,
  type ToolPermission,
} from "@deyin/host-core/shared";

/** The permission calls the panel needs. Absent where Bots have no host (chat-only web). */
export type PermissionsApi = NonNullable<DeyinApi["botPermissions"]>;

/** The approval modes in the order they are offered, each with the text that explains it. */
export const APPROVAL_MODE_OPTIONS: ReadonlyArray<{ mode: BotApprovalMode; label: MessageKey; hint: MessageKey }> = BOT_APPROVAL_MODES.map((mode) => ({
  mode,
  label: `bot.permissions.mode.${mode}` as const,
  hint: `bot.permissions.mode.${mode}.hint` as const,
}));

export const PERMISSION_OPTIONS: ReadonlyArray<{ permission: ToolPermission; label: MessageKey }> = TOOL_PERMISSIONS.map((permission) => ({
  permission,
  label: `bot.permissions.permission.${permission}` as const,
}));

export function isToolPermission(value: string): value is ToolPermission {
  return (TOOL_PERMISSIONS as readonly string[]).includes(value);
}

/* Rules ------------------------------------------------------------------- */

export type InstructionList = "allowInstructions" | "blockInstructions";

/** What stops a rule being added, as a message key, or null. */
export function ruleProblem(text: string, existing: readonly string[]): MessageKey | null {
  const rule = text.trim().replace(/\s+/g, " ");
  if (!rule) return "bot.permissions.err.rule";
  if (rule.length > PERMISSION_LIMITS.instructionLength) return "bot.permissions.err.tooLong";
  if (existing.length >= PERMISSION_LIMITS.instructions && !existing.includes(rule)) return "bot.permissions.err.full";
  return null;
}

/** The change that adds a rule to a list, or null when there is nothing to add. */
export function addRulePatch(list: InstructionList, existing: readonly string[], text: string): { autoReview: Partial<Record<InstructionList, string[]>> } | null {
  if (ruleProblem(text, existing)) return null;
  const rule = text.trim().replace(/\s+/g, " ");
  if (existing.includes(rule)) return null;
  return { autoReview: { [list]: [...existing, rule] } };
}

export function removeRulePatch(list: InstructionList, existing: readonly string[], rule: string): { autoReview: Partial<Record<InstructionList, string[]>> } {
  return { autoReview: { [list]: existing.filter((entry) => entry !== rule) } };
}

/* Tool permission rows ---------------------------------------------------- */

export type PermissionKind = "tool" | "reads" | "writes";

export interface PermissionRow {
  /** Unique within the list. */
  key: string;
  group: string;
  kind: PermissionKind;
  /** The tool's name; empty for a "reads" or "writes" default. */
  tool: string;
  permission: ToolPermission;
}

const KIND_ORDER: Record<PermissionKind, number> = { reads: 0, writes: 1, tool: 2 };

/** Every permission a person has set, grouped by tool group: the group's defaults first, then its tools by name. */
export function permissionRows(settings: BotPermissionSettings): PermissionRow[] {
  const rows: PermissionRow[] = [];
  for (const [group, policy] of Object.entries(settings.scopes)) {
    if (policy.reads) rows.push({ key: `${group}\u0000reads`, group, kind: "reads", tool: "", permission: policy.reads });
    if (policy.writes) rows.push({ key: `${group}\u0000writes`, group, kind: "writes", tool: "", permission: policy.writes });
    for (const [tool, permission] of Object.entries(policy.tools)) {
      rows.push({ key: `${group}\u0000tool\u0000${tool}`, group, kind: "tool", tool, permission });
    }
  }
  return rows.sort(
    (a, b) => a.group.localeCompare(b.group) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.tool.localeCompare(b.tool),
  );
}

export function rowLabelKey(row: PermissionRow): MessageKey {
  switch (row.kind) {
    case "tool":
      return "bot.permissions.row.tool";
    case "reads":
      return "bot.permissions.row.reads";
    case "writes":
      return "bot.permissions.row.writes";
    default: {
      const unhandled: never = row.kind;
      throw new Error(`Unhandled permission kind: ${String(unhandled)}`);
    }
  }
}

/** Set a row's permission, or with `null` remove it so the default applies again. */
export function rowPatch(row: Pick<PermissionRow, "group" | "kind" | "tool">, permission: ToolPermission | null): Record<string, unknown> {
  switch (row.kind) {
    case "tool":
      return { tool: { scope: row.group, tool: row.tool, permission } };
    case "reads":
      return { defaults: { scope: row.group, reads: permission } };
    case "writes":
      return { defaults: { scope: row.group, writes: permission } };
    default: {
      const unhandled: never = row.kind;
      throw new Error(`Unhandled permission kind: ${String(unhandled)}`);
    }
  }
}

/* Adding a permission ----------------------------------------------------- */

export interface PermissionForm {
  group: string;
  kind: PermissionKind;
  tool: string;
  permission: ToolPermission;
}

export function emptyPermissionForm(): PermissionForm {
  return { group: LOCAL_SCOPE, kind: "tool", tool: "", permission: "blocked" };
}

/** What stops a permission being added, as a message key, or null. */
export function permissionFormProblem(form: PermissionForm): MessageKey | null {
  if (!form.group.trim()) return "bot.permissions.err.group";
  if (form.kind === "tool" && !form.tool.trim()) return "bot.permissions.err.tool";
  return null;
}

export function permissionFormPatch(form: PermissionForm): Record<string, unknown> | null {
  if (permissionFormProblem(form)) return null;
  return rowPatch({ group: form.group.trim(), kind: form.kind, tool: form.tool.trim() }, form.permission);
}

/* Talking to the host ----------------------------------------------------- */

export type PermissionOutcome = { ok: true; settings: BotPermissionSettings } | { ok: false; error: string };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run a change and give back the saved settings or the reason it was refused, never a throw. */
export async function attemptPermissionUpdate(api: Pick<PermissionsApi, "update">, patch: unknown): Promise<PermissionOutcome> {
  try {
    const result: BotResult<BotPermissionSettings> = await api.update(patch);
    return result.ok ? { ok: true, settings: result.value } : { ok: false, error: result.error };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}

export async function attemptPermissionLoad(api: Pick<PermissionsApi, "get">): Promise<PermissionOutcome> {
  try {
    return { ok: true, settings: await api.get() };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}
