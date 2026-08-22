import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";
import {
  EmptyState,
  Field,
  FormSection,
  RowMenu,
  SearchField,
  SettingCard,
  Toggle,
} from "./settings/controls.js";
import { Callout } from "./ui/index.js";
import type {
  Automation,
  AutomationInfo,
  AutomationPayload,
  AutomationRun,
  AutomationTarget,
  AutomationTrigger,
  CapabilityItem,
  EnvInfo,
  ModelInfo,
  ProviderInfo,
  SshHostInfo,
} from "@deyin/contract";

type TriggerPreset = "manual" | "hourly" | "daily" | "weekdays" | "custom";
type PayloadKind = AutomationPayload["kind"];
type TargetKind = AutomationTarget["kind"];
/** Which draft field a validation message belongs to, so it renders in place. */
type FieldKey = "prompt" | "skill" | "subagent" | "workspacePath" | "hostId" | "distro";

const CRON_PRESETS: Record<Exclude<TriggerPreset, "manual" | "custom">, string> = {
  hourly: "0 * * * *",
  daily: "0 9 * * *",
  weekdays: "0 9 * * 1-5",
};

function triggerPreset(trigger: AutomationTrigger): TriggerPreset {
  if (trigger.kind === "manual") return "manual";
  if (trigger.expression === CRON_PRESETS.hourly) return "hourly";
  if (trigger.expression === CRON_PRESETS.daily) return "daily";
  if (trigger.expression === CRON_PRESETS.weekdays) return "weekdays";
  return "custom";
}

type T = ReturnType<typeof useT>;

function triggerLabel(trigger: AutomationTrigger, t: T): string {
  const preset = triggerPreset(trigger);
  if (preset === "manual") return t("automations.trigger.manual");
  if (preset === "hourly") return t("automations.trigger.hourly");
  if (preset === "daily") return t("automations.trigger.daily");
  if (preset === "weekdays") return t("automations.trigger.weekdays");
  return trigger.kind === "cron" ? trigger.expression : t("automations.trigger.manual");
}

function targetLabel(target: AutomationTarget, hosts: SshHostInfo[]): string {
  if (target.kind === "local") return shortPath(target.workspacePath);
  if (target.kind === "wsl") return `${target.distro}:${shortPath(target.workspacePath)}`;
  const host = hosts.find((h) => h.id === target.hostId);
  return host ? `${host.username}@${host.host}` : shortPath(target.workspacePath);
}

/** Last two segments of a path — list rows have no room for the whole thing. */
function shortPath(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments.slice(-2).join("/") || path;
}

function statusKey(status: AutomationRun["status"]) {
  switch (status) {
    case "queued":
      return "automations.status.queued" as const;
    case "running":
      return "automations.status.running" as const;
    case "completed":
      return "automations.status.completed" as const;
    case "failed":
      return "automations.status.failed" as const;
    case "aborted":
      return "automations.status.aborted" as const;
  }
}

function StatusPill({ status, t }: { status: AutomationRun["status"]; t: T }) {
  return (
    <span className={`run-pill run-pill--${status}`}>
      <span className="run-pill__dot" />
      {t(statusKey(status))}
    </span>
  );
}

/** One-line summary of what a saved automation actually runs. */
function payloadSummary(payload: AutomationPayload): string {
  if (payload.kind === "skill") return `/${payload.skill}`;
  if (payload.kind === "subagent") return `@${payload.subagent}`;
  return payload.prompt.slice(0, 80);
}

/**
 * A flat editing shape. The three payload fields are kept side by side rather
 * than in a union so switching kind back and forth does not lose what the user
 * already typed.
 */
interface Draft {
  name: string;
  description: string;
  payloadKind: PayloadKind;
  prompt: string;
  skill: string;
  subagent: string;
  capabilityInput: string;
  triggerPreset: TriggerPreset;
  cronExpression: string;
  targetKind: TargetKind;
  workspacePath: string;
  hostId: string;
  distro: string;
  model: string;
  providerId: string;
  enabled: boolean;
}

function emptyDraft(workspaceRoot: string | null, model: string, providerId: string): Draft {
  return {
    name: "",
    description: "",
    payloadKind: "prompt",
    prompt: "",
    skill: "",
    subagent: "",
    capabilityInput: "",
    triggerPreset: "daily",
    cronExpression: CRON_PRESETS.daily,
    targetKind: "local",
    workspacePath: workspaceRoot ?? "",
    hostId: "",
    distro: "",
    model,
    providerId,
    enabled: true,
  };
}

function draftFromAutomation(a: Automation): Draft {
  return {
    name: a.name,
    description: a.description ?? "",
    payloadKind: a.payload.kind,
    prompt: a.payload.kind === "prompt" ? a.payload.prompt : "",
    skill: a.payload.kind === "skill" ? a.payload.skill : "",
    subagent: a.payload.kind === "subagent" ? a.payload.subagent : "",
    capabilityInput: a.payload.kind === "prompt" ? "" : (a.payload.input ?? ""),
    triggerPreset: triggerPreset(a.trigger),
    cronExpression: a.trigger.kind === "cron" ? a.trigger.expression : CRON_PRESETS.daily,
    targetKind: a.target.kind,
    workspacePath: a.target.workspacePath,
    hostId: a.target.kind === "ssh" ? a.target.hostId : "",
    distro: a.target.kind === "wsl" ? a.target.distro : "",
    model: a.model,
    providerId: a.providerId,
    enabled: a.enabled,
  };
}

function draftPayload(draft: Draft): AutomationPayload {
  const input = draft.capabilityInput.trim() || undefined;
  if (draft.payloadKind === "skill") return { kind: "skill", skill: draft.skill, input };
  if (draft.payloadKind === "subagent") return { kind: "subagent", subagent: draft.subagent, input };
  return { kind: "prompt", prompt: draft.prompt };
}

function draftToAutomationInput(draft: Draft): Omit<Automation, "id" | "createdAt" | "updatedAt"> {
  const trigger: AutomationTrigger =
    draft.triggerPreset === "manual"
      ? { kind: "manual" }
      : {
          kind: "cron",
          expression:
            draft.triggerPreset === "custom"
              ? draft.cronExpression.trim()
              : CRON_PRESETS[draft.triggerPreset as Exclude<TriggerPreset, "manual" | "custom">],
        };
  const target: AutomationTarget =
    draft.targetKind === "ssh"
      ? { kind: "ssh", hostId: draft.hostId, workspacePath: draft.workspacePath }
      : draft.targetKind === "wsl"
        ? { kind: "wsl", distro: draft.distro, workspacePath: draft.workspacePath }
        : { kind: "local", workspacePath: draft.workspacePath };
  // Out-of-process targets drive the deyin CLI, which only speaks Openference.
  const providerId = draft.targetKind === "local" ? draft.providerId : "openference";
  return {
    name: draft.name.trim() || "Untitled automation",
    description: draft.description.trim() || undefined,
    payload: draftPayload(draft),
    trigger,
    target,
    model: draft.model,
    providerId,
    enabled: draft.enabled,
  };
}

interface Props {
  workspaceRoot: string | null;
  providers: ProviderInfo[];
  models: ModelInfo[];
  selectedModel: string;
  selectedProviderId: string;
  env: EnvInfo | null;
  /** Renders a back control in the header; omitted when the app shell already has nav. */
  onBack?: () => void;
  onOpenSshSettings: () => void;
}

export function AutomationsView(props: Props) {
  const t = useT();
  const api = window.deyin.automations;
  const sshApi = window.deyin.sshHosts;

  const [items, setItems] = useState<AutomationInfo[]>([]);
  const [hosts, setHosts] = useState<SshHostInfo[]>([]);
  const [skills, setSkills] = useState<CapabilityItem[]>([]);
  const [subagents, setSubagents] = useState<CapabilityItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft>(() =>
    emptyDraft(props.workspaceRoot, props.selectedModel, props.selectedProviderId),
  );
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  /** automationId → active runId (supports concurrent runs without clobbering Stop). */
  const [activeByAutomation, setActiveByAutomation] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [wslProbe, setWslProbe] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const selectedActiveRunId = selectedId ? (activeByAutomation[selectedId] ?? null) : null;
  const wslDistros = props.env?.wslDistros ?? [];

  const refresh = useCallback(async () => {
    if (!api) return;
    setItems(await api.list());
    if (sshApi) setHosts(await sshApi.list());
  }, [api, sshApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Skills and subagents back the capability payload pickers.
  useEffect(() => {
    void window.deyin.caps.list("skill").then(setSkills);
    void window.deyin.caps.list("subagent").then(setSubagents);
  }, []);

  useEffect(() => {
    if (!api) return undefined;
    const liveStatus = (event: AutomationRun["events"][number]): AutomationRun["status"] => {
      if (event.type !== "done") return "running";
      if (event.reason === "completed") return "completed";
      if (event.reason === "aborted") return "aborted";
      return "failed";
    };

    const offEvent = api.onEvent(({ runId, automationId, event }) => {
      if (automationId) setActiveByAutomation((prev) => ({ ...prev, [automationId]: runId }));
      setRuns((prev) => {
        const existing = prev.find((r) => r.id === runId);
        if (existing) {
          return prev.map((r) =>
            r.id === runId ? { ...r, status: liveStatus(event), events: [...r.events, event] } : r,
          );
        }
        // Cron / background run: prepend a stub so history is visible immediately,
        // but only when the user is actually looking at that automation.
        const viewing = selectedIdRef.current;
        if (viewing && automationId && viewing !== automationId) return prev;
        return [
          {
            id: runId,
            automationId: automationId || viewing || "",
            status: liveStatus(event),
            startedAt: Date.now(),
            events: [event],
          },
          ...prev,
        ];
      });
    });

    const offDone = api.onRunFinished(({ run }) => {
      setActiveByAutomation((prev) => {
        if (prev[run.automationId] !== run.id) return prev;
        const next = { ...prev };
        delete next[run.automationId];
        return next;
      });
      setRuns((prev) => {
        const without = prev.filter((r) => r.id !== run.id);
        if (selectedIdRef.current && run.automationId !== selectedIdRef.current) return without;
        return [run, ...without];
      });
      void refresh();
    });

    return () => {
      offEvent();
      offDone();
    };
  }, [api, refresh]);

  // Load the draft only when selection changes — not on every list refresh, or
  // an in-flight run finishing would discard the user's unsaved edits.
  useEffect(() => {
    if (!selectedId || !api) {
      setRuns([]);
      return;
    }
    const found = items.find((i) => i.id === selectedId);
    if (found) setDraft(draftFromAutomation(found));
    setDirty(false);
    setError(null);
    setFieldErrors({});
    setSavedAt(null);
    void api.runs(selectedId).then(setRuns);
    // items is deliberately omitted: see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, api]);

  const patchDraft = (patch: Partial<Draft>) => {
    setDirty(true);
    setSavedAt(null);
    setDraft((prev) => ({ ...prev, ...patch }));
    // Clear the messages for the fields being edited, so errors don't linger
    // on a field the user has already fixed.
    setFieldErrors((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(patch)) delete next[key as FieldKey];
      return next;
    });
  };

  const startNew = () => {
    setSelectedId(null);
    setDirty(false);
    setDraft(emptyDraft(props.workspaceRoot, props.selectedModel, props.selectedProviderId));
    setError(null);
    setFieldErrors({});
    setSavedAt(null);
    setRuns([]);
  };

  const validate = (): Partial<Record<FieldKey, string>> => {
    const errors: Partial<Record<FieldKey, string>> = {};
    if (draft.payloadKind === "prompt" && !draft.prompt.trim()) errors.prompt = t("automations.err.prompt");
    if (draft.payloadKind === "skill" && !draft.skill) errors.skill = t("automations.err.skill");
    if (draft.payloadKind === "subagent" && !draft.subagent) errors.subagent = t("automations.err.subagent");
    if (!draft.workspacePath.trim()) errors.workspacePath = t("automations.err.workspace");
    if (draft.targetKind === "ssh" && !draft.hostId) errors.hostId = t("automations.err.host");
    if (draft.targetKind === "wsl" && !draft.distro) errors.distro = t("automations.err.distro");
    return errors;
  };

  /** Returns the saved automation's id, or null when validation/saving failed. */
  const save = async (): Promise<string | null> => {
    if (!api) return null;
    const invalid = validate();
    setFieldErrors(invalid);
    if (Object.keys(invalid).length > 0) return null;
    setSaving(true);
    setError(null);
    try {
      const input = draftToAutomationInput(draft);
      const result = selectedId ? await api.update(selectedId, input) : await api.create(input);
      setItems(result.list);
      setSelectedId(result.automation.id);
      selectedIdRef.current = result.automation.id;
      setDirty(false);
      setSavedAt(Date.now());
      return result.automation.id;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (!api) return;
    // An unsaved draft has nothing on disk to run, so save first — Run now on a
    // clean, already-saved automation skips straight to the run.
    const id = dirty || !selectedId ? await save() : selectedId;
    if (!id) return;
    try {
      const run = await api.run(id);
      setActiveByAutomation((prev) => ({ ...prev, [id]: run.id }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const probeWsl = async () => {
    if (!api || !draft.distro) return;
    setWslProbe("…");
    const result = await api.testWsl(draft.distro);
    setWslProbe(
      result.ok ? `${result.message} (node ${result.nodeVersion}, deyin ${result.deyinVersion})` : result.message,
    );
  };

  const remove = async () => {
    if (!api || !selectedId) return;
    if (!window.confirm(t("automations.deleteConfirm"))) return;
    setItems(await api.remove(selectedId));
    startNew();
  };

  const selected = useMemo(() => items.find((i) => i.id === selectedId) ?? null, [items, selectedId]);
  const availableModels = props.models.filter((m) => m.kind !== "image");
  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) =>
      [i.name, i.description ?? "", payloadSummary(i.payload)].some((s) => s.toLowerCase().includes(q)),
    );
  }, [items, query]);

  if (!api) {
    return (
      <div className="automations automations--empty">
        <EmptyState icon="automation" title={t("automations.title")} hint={t("automations.desktopOnly")} />
      </div>
    );
  }

  const headTitle = selected ? selected.name : t("automations.new");
  const headMeta = selected
    ? `${triggerLabel(selected.trigger, t)} · ${targetLabel(selected.target, hosts)}`
    : t("automations.subtitle");

  return (
    <div className="automations">
      <aside className="automations__list">
        <div className="automations__list-head">
          <span className="automations__list-title">{t("automations.title")}</span>
          <button className="icon-btn icon-btn--small" title={t("automations.new")} onClick={startNew}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {items.length > 3 && (
          <div className="automations__search">
            <SearchField value={query} onChange={setQuery} placeholder={t("automations.searchPlaceholder")} />
          </div>
        )}
        <div className="automations__items">
          {visibleItems.map((item) => {
            const running = Boolean(activeByAutomation[item.id]);
            return (
              <button
                key={item.id}
                className={`automations__item${selectedId === item.id ? " automations__item--active" : ""}`}
                onClick={() => setSelectedId(item.id)}
              >
                <div className="automations__item-top">
                  <span className={`automations__dot${item.enabled ? " automations__dot--on" : ""}`} />
                  <span className="automations__item-title">{item.name}</span>
                  {running && <Icon name="refresh" size={12} className="automations__spin" />}
                </div>
                <div className="automations__item-meta automations__item-summary">{payloadSummary(item.payload)}</div>
                <div className="automations__item-foot">
                  <span className="automations__item-meta">
                    <Icon name="clock" size={11} /> {triggerLabel(item.trigger, t)}
                  </span>
                  {item.lastRun && <StatusPill status={item.lastRun.status} t={t} />}
                </div>
              </button>
            );
          })}
          {items.length === 0 && (
            <EmptyState icon="automation" title={t("automations.empty")} hint={t("automations.emptyHint")} />
          )}
          {items.length > 0 && visibleItems.length === 0 && (
            <EmptyState icon="search" title={t("automations.searchPlaceholder")} />
          )}
        </div>
        {items.length === 0 && (
          <button className="btn btn--primary automations__new" onClick={startNew}>
            <Icon name="plus" size={13} />
            {t("automations.new")}
          </button>
        )}
      </aside>

      <section className="automations__editor">
        <header className="automations__head">
          {props.onBack && (
            <button className="icon-btn icon-btn--small" title={t("nav.backToWorkspace")} onClick={props.onBack}>
              <Icon name="arrowLeft" size={14} />
            </button>
          )}
          <div className="automations__head-text">
            <h1 className="automations__head-title">{headTitle}</h1>
            <div className="automations__head-meta">{headMeta}</div>
          </div>
          <div className="automations__head-actions">
            <span className="automations__state">
              {dirty
                ? t("automations.unsaved")
                : savedAt
                  ? t("automations.savedJustNow")
                  : ""}
            </span>
            <button className="btn btn--ghost" disabled={saving || !dirty} onClick={() => void save()}>
              {t("automations.save")}
            </button>
            {selectedActiveRunId ? (
              <button className="btn btn--ghost" onClick={() => api.stop(selectedActiveRunId)}>
                <Icon name="close" size={13} />
                {t("automations.stop")}
              </button>
            ) : (
              <button className="btn btn--primary" disabled={saving} onClick={() => void runNow()}>
                <Icon name="play" size={13} />
                {t("automations.runNow")}
              </button>
            )}
            {selectedId && (
              <RowMenu items={[{ label: t("automations.delete"), icon: "trash", danger: true, onSelect: () => void remove() }]} />
            )}
          </div>
        </header>

        <div className="automations__body">
          {error && <Callout tone="bad" className="automations__error">{error}</Callout>}

          <FormSection title={t("automations.section.basics")}>
            <Field label={t("automations.name")} hint={t("automations.nameDesc")}>
              <input
                className="input"
                value={draft.name}
                placeholder={t("automations.namePlaceholder")}
                onChange={(e) => patchDraft({ name: e.target.value })}
              />
            </Field>
            <Field label={t("automations.description")} hint={t("automations.descriptionDesc")}>
              <input
                className="input"
                value={draft.description}
                placeholder={t("automations.descriptionPlaceholder")}
                onChange={(e) => patchDraft({ description: e.target.value })}
              />
            </Field>
            <SettingCard title={t("automations.enabled")} description={t("automations.enabledDesc")}>
              <Toggle checked={draft.enabled} onChange={(enabled) => patchDraft({ enabled })} />
            </SettingCard>
          </FormSection>

          <FormSection title={t("automations.section.prompt")}>
            <SettingCard title={t("automations.payloadKind")} description={t("automations.payloadKindDesc")}>
              <select
                className="select"
                value={draft.payloadKind}
                onChange={(e) => patchDraft({ payloadKind: e.target.value as PayloadKind })}
              >
                <option value="prompt">{t("automations.payload.prompt")}</option>
                <option value="skill">{t("automations.payload.skill")}</option>
                <option value="subagent">{t("automations.payload.subagent")}</option>
              </select>
            </SettingCard>

            {draft.payloadKind === "prompt" ? (
              <Field label={t("automations.promptLabel")} error={fieldErrors.prompt}>
                <textarea
                  className="input automations__prompt"
                  rows={7}
                  value={draft.prompt}
                  onChange={(e) => patchDraft({ prompt: e.target.value })}
                  placeholder={t("automations.promptPlaceholder")}
                />
              </Field>
            ) : (
              <>
                <Field
                  label={draft.payloadKind === "skill" ? t("automations.skill") : t("automations.subagent")}
                  hint={t("automations.capabilityDesc")}
                  error={draft.payloadKind === "skill" ? fieldErrors.skill : fieldErrors.subagent}
                >
                  <select
                    className="select"
                    value={draft.payloadKind === "skill" ? draft.skill : draft.subagent}
                    onChange={(e) =>
                      patchDraft(
                        draft.payloadKind === "skill" ? { skill: e.target.value } : { subagent: e.target.value },
                      )
                    }
                  >
                    <option value="">{t("automations.selectCapability")}</option>
                    {(draft.payloadKind === "skill" ? skills : subagents).map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                        {c.enabled ? "" : ` (${t("automations.disabled")})`}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("automations.capabilityInput")} hint={t("automations.capabilityInputDesc")}>
                  <input
                    className="input"
                    value={draft.capabilityInput}
                    onChange={(e) => patchDraft({ capabilityInput: e.target.value })}
                  />
                </Field>
              </>
            )}
          </FormSection>

          <FormSection title={t("automations.section.trigger")}>
            <SettingCard title={t("automations.schedule")}>
              <select
                className="select"
                value={draft.triggerPreset}
                onChange={(e) => {
                  const preset = e.target.value as TriggerPreset;
                  patchDraft({
                    triggerPreset: preset,
                    cronExpression:
                      preset !== "manual" && preset !== "custom" ? CRON_PRESETS[preset] : draft.cronExpression,
                  });
                }}
              >
                <option value="manual">{t("automations.trigger.manual")}</option>
                <option value="hourly">{t("automations.trigger.hourly")}</option>
                <option value="daily">{t("automations.trigger.daily")}</option>
                <option value="weekdays">{t("automations.trigger.weekdays")}</option>
                <option value="custom">{t("automations.trigger.custom")}</option>
              </select>
            </SettingCard>
            {draft.triggerPreset === "custom" && (
              <Field label={t("automations.cron")} hint={t("automations.cronDesc")}>
                <input
                  className="input input-mono"
                  value={draft.cronExpression}
                  onChange={(e) => patchDraft({ cronExpression: e.target.value })}
                />
              </Field>
            )}
            {draft.triggerPreset !== "manual" && <Callout tone="muted">{t("automations.scheduleCaveat")}</Callout>}
          </FormSection>

          <FormSection title={t("automations.section.target")}>
            <SettingCard title={t("automations.targetKind")}>
              <select
                className="select"
                value={draft.targetKind}
                onChange={(e) => patchDraft({ targetKind: e.target.value as TargetKind })}
              >
                <option value="local">{t("automations.target.local")}</option>
                {wslDistros.length > 0 && <option value="wsl">{t("automations.target.wsl")}</option>}
                <option value="ssh">{t("automations.target.ssh")}</option>
              </select>
            </SettingCard>

            {draft.targetKind === "wsl" && (
              <Field
                label={t("automations.distro")}
                hint={wslProbe ?? t("automations.distroDesc")}
                error={fieldErrors.distro}
                action={
                  <button className="btn btn--ghost btn--small" disabled={!draft.distro} onClick={() => void probeWsl()}>
                    {t("automations.test")}
                  </button>
                }
              >
                <select
                  className="select"
                  value={draft.distro}
                  onChange={(e) => {
                    setWslProbe(null);
                    patchDraft({ distro: e.target.value });
                  }}
                >
                  <option value="">{t("automations.selectDistro")}</option>
                  {wslDistros.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {draft.targetKind === "ssh" && (
              <Field
                label={t("automations.sshHost")}
                error={fieldErrors.hostId}
                action={
                  <button className="btn btn--ghost btn--small" onClick={props.onOpenSshSettings}>
                    {t("automations.manageHosts")}
                  </button>
                }
              >
                <select className="select" value={draft.hostId} onChange={(e) => patchDraft({ hostId: e.target.value })}>
                  <option value="">{t("automations.selectHost")}</option>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label} ({h.username}@{h.host})
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field
              label={t("automations.workspacePath")}
              hint={draft.targetKind === "wsl" ? t("automations.wslPathHint") : t("automations.workspacePathDesc")}
              error={fieldErrors.workspacePath}
            >
              <input
                className="input input-mono"
                value={draft.workspacePath}
                onChange={(e) => patchDraft({ workspacePath: e.target.value })}
              />
            </Field>

            {draft.targetKind !== "local" && <Callout tone="muted">{t("automations.sshOpenferenceOnly")}</Callout>}
          </FormSection>

          <FormSection title={t("automations.section.model")}>
            <SettingCard title={t("automations.model")}>
              <select className="select" value={draft.model} onChange={(e) => patchDraft({ model: e.target.value })}>
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            </SettingCard>
          </FormSection>

          <FormSection
            title={t("automations.section.history")}
            note={runs.length > 0 ? `${runs.length} ${t("automations.runsCount")}` : undefined}
          >
            {runs.length === 0 && (
              <p className="field__hint automations__no-runs">
                {selectedId ? t("automations.noRuns") : t("automations.noSelection")}
              </p>
            )}
            {runs.map((run) => (
              <div key={run.id} className="automations__run">
                <div className="automations__run-head">
                  <StatusPill status={run.status} t={t} />
                  <span className="automations__run-time">{new Date(run.startedAt).toLocaleString()}</span>
                </div>
                {run.reason && <div className="automations__run-reason">{run.reason}</div>}
                {run.finalText && (
                  <details className="automations__run-details">
                    <summary>{t("automations.viewOutput")}</summary>
                    <pre className="automations__run-text">{run.finalText.slice(0, 4000)}</pre>
                  </details>
                )}
              </div>
            ))}
          </FormSection>
        </div>
      </section>
    </div>
  );
}
