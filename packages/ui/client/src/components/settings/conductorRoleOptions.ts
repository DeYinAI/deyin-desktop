import { CONDUCTOR_ROLE_INFO, resolveConductorRoleAgent, type ConductorRolePreferences } from "@deyin/host-core/shared";
import type { ConductorRole, ExternalAgentDescriptor } from "@deyin/contract";
import type { MenuSelectOption } from "../MenuSelect.js";

/** The id of the option that clears a role's saved choice. */
export const AUTOMATIC_AGENT_ID = "";

/**
 * The choices for one role's agent menu: "Automatic" first (saying which agent
 * that means right now and why), then every installed agent, then, when the
 * saved agent has since been uninstalled, that agent as a disabled entry so the
 * stale choice stays visible instead of silently changing.
 */
export function conductorRoleOptions(
  role: ConductorRole,
  agents: readonly ExternalAgentDescriptor[],
  preferences: ConductorRolePreferences,
): MenuSelectOption<string>[] {
  const installed = agents.filter((agent) => agent.installed);
  const agentName = (id: string): string => agents.find((agent) => agent.id === id)?.name ?? id;

  const automatic = resolveConductorRoleAgent(role, {}, installed);
  const usual = CONDUCTOR_ROLE_INFO[role].defaultAgentId;
  let hint: string;
  if (!automatic) hint = "No agent is installed.";
  else if (automatic.source === "default") hint = "The usual choice for this kind of work.";
  else if (usual) hint = `${agentName(usual)} is not installed, so the first installed agent is used.`;
  else hint = "No usual choice for this role, so the first installed agent is used.";

  const options: MenuSelectOption<string>[] = [
    {
      id: AUTOMATIC_AGENT_ID,
      label: automatic ? `Automatic · ${agentName(automatic.agentId)}` : "Automatic",
      hint,
    },
    ...installed.map((agent) => ({
      id: agent.id,
      label: agent.name,
      hint: agent.authStatus === "unauthenticated" ? "Not signed in" : undefined,
    })),
  ];

  const saved = preferences[role];
  if (saved && !installed.some((agent) => agent.id === saved)) {
    options.push({ id: saved, label: `${agentName(saved)} (not installed)`, disabled: true });
  }
  return options;
}

/** `preferences` with `role` set to `agentId`, or cleared when `agentId` is the automatic option. */
export function withRoleChoice(preferences: ConductorRolePreferences, role: ConductorRole, agentId: string): ConductorRolePreferences {
  const next: ConductorRolePreferences = { ...preferences };
  if (agentId === AUTOMATIC_AGENT_ID) delete next[role];
  else next[role] = agentId;
  return next;
}
