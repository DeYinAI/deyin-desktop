import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONDUCTOR_PREFERENCE_ROLES, CONDUCTOR_ROLE_INFO, type ConductorRolePreferences } from "@deyin/host-core/shared";
import type { ConductorRole, ExternalAgentDescriptor } from "@deyin/contract";
import { Icon, type IconName } from "../Icon.js";
import { MenuSelect } from "../MenuSelect.js";
import { conductorRoleOptions, withRoleChoice } from "./conductorRoleOptions.js";
import { EmptyState, PageHeader, Row, RowList, SectionHeader } from "./controls.js";

const ROLE_ICON: Record<ConductorRole, IconName> = {
  plan: "map",
  code: "terminal",
  review: "diff",
  test: "shield",
  design: "palette",
  docs: "folderOpen",
  custom: "sparkles",
};

interface ConductorPageProps {
  /** Explicit role -> agent choices; a role left out follows the built-in choice. */
  preferences: ConductorRolePreferences;
  onChange: (next: ConductorRolePreferences) => void;
}

/**
 * Conductor settings: which installed coding agent should take each kind of
 * pipeline stage. Choices are advisory. They steer the agent Conductor proposes
 * when you describe a pipeline in chat; a stage can still name any agent.
 */
export function ConductorPage({ preferences, onChange }: ConductorPageProps) {
  const [agents, setAgents] = useState<ExternalAgentDescriptor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async (force: boolean) => {
    setRefreshing(true);
    try {
      const list = await window.deyin.externalAgents.list(force);
      if (!mounted.current) return;
      setAgents(list);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : "Could not detect agents.");
      setAgents((current) => current ?? []);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(false);
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const installed = useMemo(() => (agents ?? []).filter((agent) => agent.installed), [agents]);

  const choose = (role: ConductorRole, agentId: string) => onChange(withRoleChoice(preferences, role, agentId));

  const chosenCount = CONDUCTOR_PREFERENCE_ROLES.filter((role) => preferences[role]).length;

  return (
    <div className="settings-page">
      <PageHeader
        title="Conductor"
        description="Conductor hands work to coding agents installed on this computer. Pick which one you prefer for each kind of stage; when you describe a pipeline in chat, it assigns agents by role using these choices."
      >
        <button
          type="button"
          className="btn btn--subtle btn--sm"
          disabled={refreshing}
          onClick={() => void load(true)}
        >
          {refreshing ? "Detecting…" : "Detect agents again"}
        </button>
      </PageHeader>

      {error && <p className="ui-callout">Agent detection failed: {error}</p>}

      {agents === null ? (
        <p className="settings-page__desc">Detecting installed agents…</p>
      ) : installed.length === 0 ? (
        <EmptyState
          icon="bot"
          title="No coding agents detected"
          hint="Install Claude Code, Codex, ZCode, OpenCode or Cursor CLI, then detect again."
        />
      ) : (
        <>
          <SectionHeader
            title="Agent roles"
            note={chosenCount === 0 ? "Every role follows its automatic choice" : `${chosenCount} chosen by you`}
          />
          <RowList>
            {CONDUCTOR_PREFERENCE_ROLES.map((role) => (
              <Row
                key={role}
                icon={<Icon name={ROLE_ICON[role]} size={14} />}
                title={CONDUCTOR_ROLE_INFO[role].label}
                description={CONDUCTOR_ROLE_INFO[role].description}
                aside={
                  <MenuSelect
                    label={`Agent for ${CONDUCTOR_ROLE_INFO[role].label.toLowerCase()} stages`}
                    value={preferences[role] ?? ""}
                    options={conductorRoleOptions(role, agents ?? [], preferences)}
                    align="end"
                    onChange={(agentId) => choose(role, agentId)}
                  />
                }
              />
            ))}
          </RowList>
        </>
      )}
    </div>
  );
}
