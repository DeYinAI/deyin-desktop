import { useMemo } from "react";
import { Icon } from "../Icon.js";
import { EmptyState, PageHeader, RowList, Row, SectionHeader } from "./controls.js";
import type { CapabilityItem, ModelInfo, ProviderInfo } from "@deyin/contract";

/**
 * Roles a run can route to. `implement` is the working default; `plan`, `ask`
 * and `delivery` follow the composer mode; `tool` is the opportunistic cheap
 * role used for read-only tool churn between reasoning steps.
 */
const ROLES = [
  {
    id: "implement",
    label: "Implementing",
    hint: "Agent mode — writing code, running commands, driving the task to done.",
    icon: "bolt",
  },
  {
    id: "plan",
    label: "Planning",
    hint: "Plan mode — read-only research that ends in a structured plan.",
    icon: "sparkles",
  },
  {
    id: "ask",
    label: "Asking",
    hint: "Ask mode — read-only questions about the codebase.",
    icon: "zoom",
  },
  {
    id: "delivery",
    label: "Delivery",
    hint: "Delivery mode — evidence gates, verification and step sign-offs.",
    icon: "shield",
  },
  {
    id: "tool",
    label: "Tool calling",
    hint: "Continuation steps that only read and search. Point this at a fast, cheap model.",
    icon: "terminal",
  },
] as const;

interface Props {
  /** Enabled providers, used to build the "providerId::modelId" option list. */
  providers: ProviderInfo[];
  /** Live models for the primary provider. */
  liveModels: ModelInfo[];
  /** role -> "providerId::modelId"; roles left out inherit the session model. */
  roleModels: Record<string, string>;
  /** Subagent capability items, so per-subagent overrides live here too. */
  subagents: CapabilityItem[];
  subagentModels: Record<string, string>;
  onSetRoleModel: (role: string, model: string | undefined) => void;
  onSetSubagentModel: (name: string, model: string | undefined) => void;
}

/** Flatten enabled providers' models into "providerId::modelId" options. */
function modelOptions(
  providers: ProviderInfo[],
  liveModels: ModelInfo[],
): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const p of providers.filter((p) => p.enabled)) {
    const list = p.kind === "primary" ? liveModels : p.models;
    const disabled = new Set(p.disabledModels);
    for (const m of list) {
      // Image models take a prompt, not a conversation: never offer them here.
      if (disabled.has(m.id) || m.kind === "image") continue;
      out.push({ value: `${p.id}::${m.id}`, label: `${p.name} · ${m.name}` });
    }
  }
  return out;
}

function ModelSelect(props: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  placeholder: string;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <select
      className="select select--small"
      aria-label={props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value || undefined)}
    >
      <option value="">{props.placeholder}</option>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Per-phase model routing. Each role can run on its own model (and its own
 * provider), so planning can use a strong reasoning model while mechanical tool
 * churn falls to a cheap fast one. Anything left on "Inherit" uses whichever
 * model the thread itself is set to.
 */
export function ModelRolesPage(props: Props) {
  const options = useMemo(
    () => modelOptions(props.providers, props.liveModels),
    [props.providers, props.liveModels],
  );
  const configured = ROLES.filter((r) => props.roleModels[r.id]).length;

  return (
    <div className="settings-page">
      <PageHeader
        title="Model roles"
        description="Route each phase of a run to its own model. Roles left on “Inherit” use the model selected in the composer."
      />

      {options.length === 0 ? (
        <EmptyState
          icon="cpu"
          title="No models available"
          hint="Connect or enable a provider in Model settings first."
        />
      ) : (
        <>
          <SectionHeader
            title="Phases"
            count={`${configured}/${ROLES.length}`}
            note={configured === 0 ? "All phases inherit the thread's model" : undefined}
          />
          <RowList>
            {ROLES.map((role) => (
              <Row
                key={role.id}
                icon={<Icon name={role.icon} size={14} />}
                title={role.label}
                description={role.hint}
                aside={
                  <ModelSelect
                    label={`Model for ${role.label}`}
                    value={props.roleModels[role.id] ?? ""}
                    options={options}
                    placeholder="Inherit thread model"
                    onChange={(value) => props.onSetRoleModel(role.id, value)}
                  />
                }
              />
            ))}
          </RowList>

          <SectionHeader
            title="Subagents"
            count={props.subagents.length}
            note="Delegated runs; frontmatter model: is the fallback"
          />
          {props.subagents.length === 0 ? (
            <EmptyState icon="brain" title="No subagents installed" />
          ) : (
            <RowList>
              {props.subagents.map((item) => (
                <Row
                  key={item.id}
                  icon={<Icon name="brain" size={14} />}
                  title={item.name}
                  description={item.description || item.path}
                  aside={
                    <ModelSelect
                      label={`Model for ${item.name}`}
                      value={item.model ?? ""}
                      options={options}
                      placeholder={item.effectiveModel ? `Auto · ${item.effectiveModel}` : "Inherit main model"}
                      onChange={(value) => props.onSetSubagentModel(item.name, value)}
                    />
                  }
                />
              ))}
            </RowList>
          )}
        </>
      )}
    </div>
  );
}
