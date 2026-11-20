/**
 * Roles for Conductor pipelines: what a stage is *for* (plan, code, review, ...),
 * and which external agent the user would rather have do that kind of work.
 *
 * Roles are advisory. The pipeline engine runs whatever `agentId` a stage names;
 * a role only labels the stage, drives the defaults the authoring skill offers,
 * and lets validation warn when a stage disagrees with the user's preference.
 *
 * Browser-safe on purpose (no `node:` imports): the settings page and the stage
 * cards read this too, so it is exported from the shared surface.
 */
import type { ConductorRole } from "./types.js";

export interface ConductorRoleInfo {
  label: string;
  /** One sentence for settings and for the model: what a stage with this role does. */
  description: string;
  /** Agent preferred when the user has not chosen one and that agent is installed. */
  defaultAgentId?: string;
}

/**
 * Every role. Typed as a `Record` so adding a role to `ConductorRole` without
 * describing it here fails the build.
 */
export const CONDUCTOR_ROLE_INFO: Record<ConductorRole, ConductorRoleInfo> = {
  plan: {
    label: "Plan",
    description: "Research the codebase and write the plan or specification.",
    defaultAgentId: "claude",
  },
  code: {
    label: "Code",
    description: "Implement the change in an isolated worktree.",
    defaultAgentId: "zcode",
  },
  review: {
    label: "Review",
    description: "Critique a plan or a diff and report concrete problems.",
    defaultAgentId: "codex",
  },
  test: {
    label: "Test",
    description: "Run and extend tests and confirm the change works.",
  },
  design: {
    label: "Design",
    description: "Interface, layout, or copy work.",
  },
  docs: {
    label: "Docs",
    description: "Write or refresh documentation.",
  },
  custom: {
    label: "Custom",
    description: "Anything that fits none of the other roles.",
  },
};

export const CONDUCTOR_ROLES: readonly ConductorRole[] = Object.keys(CONDUCTOR_ROLE_INFO) as ConductorRole[];

/** Roles a preference can be set for: "custom" has no sensible default agent. */
export const CONDUCTOR_PREFERENCE_ROLES: readonly ConductorRole[] = CONDUCTOR_ROLES.filter((role) => role !== "custom");

export type ConductorRolePreferences = Partial<Record<ConductorRole, string>>;

export function isConductorRole(value: unknown): value is ConductorRole {
  return typeof value === "string" && (CONDUCTOR_ROLES as readonly string[]).includes(value);
}

export function conductorRoleLabel(role: ConductorRole): string {
  return CONDUCTOR_ROLE_INFO[role].label;
}

/** Role -> agent map from disk or an IPC patch: known roles with non-blank agent ids only. */
export function sanitizeConductorRolePreferences(value: unknown): ConductorRolePreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const clean: ConductorRolePreferences = {};
  for (const role of CONDUCTOR_PREFERENCE_ROLES) {
    const entry = (value as Record<string, unknown>)[role];
    if (typeof entry === "string" && entry.trim().length > 0) clean[role] = entry.trim();
  }
  return clean;
}

/** The only facts about an agent that choosing one for a role depends on. */
export interface ConductorRoleAgentFacts {
  id: string;
  installed: boolean;
}

/**
 * Where a role's agent came from: the user's own choice, the built-in default
 * for that role, or simply the first installed agent because neither applied.
 */
export type ConductorRoleSource = "preference" | "default" | "fallback";

export interface ResolvedConductorRole {
  role: ConductorRole;
  agentId: string;
  source: ConductorRoleSource;
}

/**
 * The agent that should do `role`, or null when no agent is installed.
 *
 * A preference or default is honored only while that agent is installed, so a
 * missing CLI degrades to the next best thing instead of naming an agent the
 * engine cannot start. `agents` keeps its given order; the first installed
 * agent is the fallback.
 */
export function resolveConductorRoleAgent(
  role: ConductorRole,
  preferences: ConductorRolePreferences,
  agents: readonly ConductorRoleAgentFacts[],
): ResolvedConductorRole | null {
  const installed = agents.filter((agent) => agent.installed);
  if (installed.length === 0) return null;
  const isInstalled = (id: string | undefined): id is string => id !== undefined && installed.some((a) => a.id === id);

  const preferred = role === "custom" ? undefined : preferences[role];
  if (isInstalled(preferred)) return { role, agentId: preferred, source: "preference" };

  const fallbackDefault = CONDUCTOR_ROLE_INFO[role].defaultAgentId;
  if (isInstalled(fallbackDefault)) return { role, agentId: fallbackDefault, source: "default" };

  return { role, agentId: installed[0]!.id, source: "fallback" };
}

/**
 * The agent the user chose for `role` when a stage runs a different one, else
 * null. Only an explicit, installed preference counts: the built-in defaults are
 * suggestions, not a statement of what the user wants, so a stage that ignores
 * one is not in conflict with anything.
 */
export function conductorRolePreferenceConflict(
  role: ConductorRole | undefined,
  agentId: string,
  preferences: ConductorRolePreferences,
  agents: readonly ConductorRoleAgentFacts[],
): string | null {
  if (role === undefined || role === "custom") return null;
  const preferred = preferences[role];
  if (preferred === undefined || preferred === agentId) return null;
  return agents.some((agent) => agent.id === preferred && agent.installed) ? preferred : null;
}

/** Every preferable role resolved against the installed agents; empty when none is installed. */
export function resolveConductorRoles(
  preferences: ConductorRolePreferences,
  agents: readonly ConductorRoleAgentFacts[],
): ResolvedConductorRole[] {
  const resolved: ResolvedConductorRole[] = [];
  for (const role of CONDUCTOR_PREFERENCE_ROLES) {
    const entry = resolveConductorRoleAgent(role, preferences, agents);
    if (entry) resolved.push(entry);
  }
  return resolved;
}
