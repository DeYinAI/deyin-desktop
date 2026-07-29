import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./settings/controls.js";
import type {
  Automation,
  AutomationInfo,
  AutomationRun,
  AutomationTarget,
  AutomationTrigger,
  ModelInfo,
  ProviderInfo,
  SshHostInfo,
} from "../../shared/types.js";

type TriggerPreset = "manual" | "hourly" | "daily" | "weekdays" | "custom";

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

function triggerLabel(trigger: AutomationTrigger, t: (k: import("@deyin/host-core/shared").MessageKey) => string): string {
  const preset = triggerPreset(trigger);
  if (preset === "manual") return t("automations.trigger.manual");
  if (preset === "hourly") return t("automations.trigger.hourly");
  if (preset === "daily") return t("automations.trigger.daily");
  if (preset === "weekdays") return t("automations.trigger.weekdays");
  return trigger.kind === "cron" ? trigger.expression : t("automations.trigger.manual");
}

function targetLabel(target: AutomationTarget, hosts: SshHostInfo[]): string {
  if (target.kind === "local") return target.workspacePath;
  const host = hosts.find((h) => h.id === target.hostId);
  return host ? `${host.username}@${host.host}:${target.workspacePath}` : target.workspacePath;
}

function statusKey(status: AutomationRun["status"]): import("@deyin/host-core/shared").MessageKey {
  switch (status) {
    case "queued":
      return "automations.status.queued";
    case "running":
      return "automations.status.running";
    case "completed":
      return "automations.status.completed";
    case "failed":
      return "automations.status.failed";
    case "aborted":
      return "automations.status.aborted";
  }
}

interface Draft {
  name: string;
  description: string;
  prompt: string;
  triggerPreset: TriggerPreset;
  cronExpression: string;
  targetKind: "local" | "ssh";
  workspacePath: string;
  hostId: string;
  model: string;
  providerId: string;
  enabled: boolean;
}

function emptyDraft(workspaceRoot: string | null, model: string, providerId: string): Draft {
  return {
    name: "",
    description: "",
    prompt: "",
    triggerPreset: "daily",
    cronExpression: CRON_PRESETS.daily,
    targetKind: "local",
    workspacePath: workspaceRoot ?? "",
    hostId: "",
    model,
    providerId,
    enabled: true,
  };
}

function draftFromAutomation(a: Automation): Draft {
  return {
    name: a.name,
    description: a.description ?? "",
    prompt: a.prompt,
    triggerPreset: triggerPreset(a.trigger),
    cronExpression: a.trigger.kind === "cron" ? a.trigger.expression : CRON_PRESETS.daily,
    targetKind: a.target.kind === "ssh" ? "ssh" : "local",
    workspacePath: a.target.workspacePath,
    hostId: a.target.kind === "ssh" ? a.target.hostId : "",
    model: a.model,
    providerId: a.providerId,
    enabled: a.enabled,
  };
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
      : { kind: "local", workspacePath: draft.workspacePath };
  const providerId = draft.targetKind === "ssh" ? "openference" : draft.providerId;
  return {
    name: draft.name.trim() || "Untitled automation",
    description: draft.description.trim() || undefined,
    prompt: draft.prompt,
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
  onBack: () => void;
  onOpenSshSettings: () => void;
}

export function AutomationsView(props: Props) {
  const t = useT();
  const [items, setItems] = useState<AutomationInfo[]>([]);
  const [hosts, setHosts] = useState<SshHostInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() =>
    emptyDraft(props.workspaceRoot, props.selectedModel, props.selectedProviderId),
  );
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [liveEvents, setLiveEvents] = useState<Record<string, AutomationRun["events"]>>({});
  /** automationId → active runId (supports concurrent runs without clobbering Stop). */
  const [activeByAutomation, setActiveByAutomation] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const runsFetchGenRef = useRef(0);
  const runsRef = useRef(runs);
  selectedIdRef.current = selectedId;
  runsRef.current = runs;
  const selectedActiveRunId = selectedId ? (activeByAutomation[selectedId] ?? null) : null;

  const refresh = useCallback(async () => {
    setItems(await window.deyin.automations.list());
    setHosts(await window.deyin.sshHosts.list());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const liveStatus = (event: AutomationRun["events"][number]): AutomationRun["status"] => {
      if (event.type !== "done") return "running";
      if (event.reason === "completed") return "completed";
      if (event.reason === "aborted") return "aborted";
      return "failed";
    };

    const offEvent = window.deyin.automations.onEvent(({ runId, automationId, event }) => {
      if (automationId) {
        setActiveByAutomation((prev) => ({ ...prev, [automationId]: runId }));
      }
      setLiveEvents((prev) => {
        const events = [...(prev[runId] ?? []), event];
        return { ...prev, [runId]: events };
      });
      setRuns((prev) => {
        const existing = prev.find((r) => r.id === runId);
        if (existing) {
          return prev.map((r) =>
            r.id === runId
              ? {
                  ...r,
                  status: liveStatus(event),
                  events: [...r.events, event],
                }
              : r,
          );
        }
        // Cron / background run: prepend a stub so history is visible immediately.
        // Only inject into the list when viewing that automation (or no selection yet).
        const viewing = selectedIdRef.current;
        if (viewing && automationId && viewing !== automationId) return prev;
        const stub: AutomationRun = {
          id: runId,
          automationId: automationId || viewing || "",
          status: liveStatus(event),
          startedAt: Date.now(),
          events: [event],
        };
        return [stub, ...prev];
      });
    });
    const offDone = window.deyin.automations.onRunFinished(({ run }) => {
      setActiveByAutomation((prev) => {
        if (prev[run.automationId] !== run.id) return prev;
        const next = { ...prev };
        delete next[run.automationId];
        return next;
      });
      setLiveEvents((prev) => {
        if (!(run.id in prev)) return prev;
        const next = { ...prev };
        delete next[run.id];
        return next;
      });
      setRuns((prev) => {
        const without = prev.filter((r) => r.id !== run.id);
        // Keep finished run visible if it belongs to the selected automation.
        if (selectedIdRef.current && run.automationId !== selectedIdRef.current) return without;
        return [run, ...without];
      });
      void refresh();
    });
    return () => {
      offEvent();
      offDone();
    };
  }, [refresh]);

  // Load draft only when selection changes — not on every items refresh (preserves edits).
  useEffect(() => {
    if (!selectedId) {
      setRuns([]);
      return;
    }
    dirtyRef.current = false;
    const gen = ++runsFetchGenRef.current;
    void window.deyin.automations.runs(selectedId).then((fetched) => {
      if (runsFetchGenRef.current !== gen) return;
      const prev = runsRef.current;
      const byId = new Map(fetched.map((r) => [r.id, r]));
      const isActive = (s: AutomationRun["status"]) => s === "running" || s === "queued";
      for (const live of prev) {
        if (live.automationId !== selectedId) continue;
        const stored = byId.get(live.id);
        if (!stored) {
          byId.set(live.id, live);
          continue;
        }
        if (isActive(live.status)) {
          // Live run still in flight: trust live status, but keep stored startedAt.
          byId.set(live.id, { ...stored, ...live, startedAt: stored.startedAt });
        } else {
          // Live run is terminal: trust stored metadata (final persisted status/reason)
          // but keep whichever events stream is longer so the final deltas survive.
          byId.set(live.id, {
            ...stored,
            events: live.events.length >= stored.events.length ? live.events : stored.events,
          });
        }
      }
      const merged = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
      setRuns(merged);
      const active = merged.find((r) => r.status === "running" || r.status === "queued");
      setActiveByAutomation((map) => {
        if (active) {
          if (map[selectedId] === active.id) return map;
          return { ...map, [selectedId]: active.id };
        }
        if (!(selectedId in map)) return map;
        // Fetch+merge idle: drop ghost Stop (no local running/queued row either).
        const next = { ...map };
        delete next[selectedId];
        return next;
      });
    });
    void window.deyin.automations.list().then((list) => {
      const item = list.find((a) => a.id === selectedId);
      if (item && !dirtyRef.current) setDraft(draftFromAutomation(item));
    });
  }, [selectedId]);

  const selected = useMemo(() => items.find((a) => a.id === selectedId) ?? null, [items, selectedId]);

  const providerOptions = useMemo(() => {
    if (draft.targetKind === "ssh") {
      return props.providers.filter((p) => p.id === "openference" || p.kind === "primary");
    }
    return props.providers;
  }, [draft.targetKind, props.providers]);

  const modelOptions = useMemo(() => {
    const provider = props.providers.find((p) => p.id === draft.providerId);
    if (provider?.models?.length) return provider.models.map((m) => m.id);
    return props.models.map((m) => m.id);
  }, [draft.providerId, props.providers, props.models]);

  const patchDraft = (patch: Partial<Draft>): void => {
    dirtyRef.current = true;
    setDraft((d) => {
      const next = { ...d, ...patch };
      if (patch.targetKind === "ssh") {
        next.providerId = "openference";
      }
      return next;
    });
  };

  const save = async (): Promise<string | null> => {
    setSaving(true);
    setError(null);
    try {
      const input = draftToAutomationInput(draft);
      if (!input.prompt.trim()) throw new Error(t("automations.err.prompt"));
      if (!input.target.workspacePath.trim()) throw new Error(t("automations.err.workspace"));
      if (input.target.kind === "ssh" && !input.target.hostId) throw new Error(t("automations.err.host"));

      if (selectedId) {
        const result = await window.deyin.automations.update(selectedId, input);
        setItems(result.list);
        dirtyRef.current = false;
        return result.automation.id;
      }
      const result = await window.deyin.automations.create(input);
      setItems(result.list);
      setSelectedId(result.automation.id);
      dirtyRef.current = false;
      return result.automation.id;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const runNow = async (): Promise<void> => {
    setError(null);
    try {
      const id = await save();
      if (!id) return;
      const run = await window.deyin.automations.run(id);
      setActiveByAutomation((prev) => ({ ...prev, [id]: run.id }));
      setLiveEvents((prev) => ({ ...prev, [run.id]: [] }));
      setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stopRun = (): void => {
    if (!selectedActiveRunId) return;
    window.deyin.automations.stop(selectedActiveRunId);
  };

  return (
    <div className="automations">
      <aside className="automations__list">
        <button className="settings__back" onClick={props.onBack}>
          <Icon name="arrowLeft" size={13} />
          {t("nav.backToWorkspace")}
        </button>
        <PageHeader title={t("automations.title")} description={t("automations.desc")} />
        <button
          className="btn btn--primary automations__new"
          onClick={() => {
            setSelectedId(null);
            dirtyRef.current = false;
            setDraft(emptyDraft(props.workspaceRoot, props.selectedModel, props.selectedProviderId));
            setError(null);
          }}
        >
          <Icon name="plus" size={13} />
          {t("automations.new")}
        </button>
        <div className="automations__items">
          {items.map((item) => (
            <button
              key={item.id}
              className={`automations__item ${selectedId === item.id ? "automations__item--active" : ""}`}
              onClick={() => setSelectedId(item.id)}
            >
              <div className="automations__item-title">{item.name}</div>
              <div className="automations__item-meta">
                {triggerLabel(item.trigger, t)} · {targetLabel(item.target, hosts)}
              </div>
              {item.lastRun && (
                <div className={`automations__status automations__status--${item.lastRun.status}`}>
                  {t(statusKey(item.lastRun.status))}
                </div>
              )}
            </button>
          ))}
          {items.length === 0 && <p className="hint automations__empty">{t("automations.empty")}</p>}
        </div>
      </aside>

      <div className="automations__editor settings-page">
        <PageHeader title={selected ? selected.name : t("automations.new")}>
          <div className="automations__actions">
            {selectedId && (
              <button
                className="btn btn--ghost"
                onClick={() =>
                  void window.deyin.automations.remove(selectedId).then((next) => {
                    setItems(next);
                    setSelectedId(null);
                    dirtyRef.current = false;
                    setDraft(emptyDraft(props.workspaceRoot, props.selectedModel, props.selectedProviderId));
                  })
                }
              >
                {t("automations.delete")}
              </button>
            )}
            <button className="btn btn--ghost" disabled={saving} onClick={() => void save()}>
              {t("automations.save")}
            </button>
            {selectedActiveRunId ? (
              <button className="btn btn--ghost" onClick={stopRun}>
                {t("automations.stop")}
              </button>
            ) : (
              <button className="btn btn--primary" onClick={() => void runNow()}>
                {t("automations.runNow")}
              </button>
            )}
          </div>
        </PageHeader>

        {error && <p className="hint automations__error">{error}</p>}

        <SectionTitle>{t("automations.section.basics")}</SectionTitle>
        <SettingCard title={t("automations.name")}>
          <input className="input" value={draft.name} onChange={(e) => patchDraft({ name: e.target.value })} />
        </SettingCard>
        <SettingCard title={t("automations.description")}>
          <input
            className="input"
            value={draft.description}
            onChange={(e) => patchDraft({ description: e.target.value })}
          />
        </SettingCard>
        <SettingCard title={t("automations.enabled")}>
          <Toggle checked={draft.enabled} onChange={(enabled) => patchDraft({ enabled })} />
        </SettingCard>

        <SectionTitle>{t("automations.section.prompt")}</SectionTitle>
        <textarea
          className="input automations__prompt"
          rows={6}
          value={draft.prompt}
          onChange={(e) => patchDraft({ prompt: e.target.value })}
          placeholder={t("automations.promptPlaceholder")}
        />

        <SectionTitle>{t("automations.section.trigger")}</SectionTitle>
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
          <SettingCard title={t("automations.cron")} description={t("automations.cronDesc")}>
            <input
              className="input"
              value={draft.cronExpression}
              onChange={(e) => patchDraft({ cronExpression: e.target.value })}
            />
          </SettingCard>
        )}

        <SectionTitle>{t("automations.section.target")}</SectionTitle>
        <SettingCard title={t("automations.targetKind")}>
          <select
            className="select"
            value={draft.targetKind}
            onChange={(e) => patchDraft({ targetKind: e.target.value as "local" | "ssh" })}
          >
            <option value="local">{t("automations.target.local")}</option>
            <option value="ssh">{t("automations.target.ssh")}</option>
          </select>
        </SettingCard>
        {draft.targetKind === "ssh" && (
          <>
            <p className="hint">{t("automations.sshOpenferenceOnly")}</p>
            <SettingCard title={t("automations.sshHost")}>
              <div className="automations__row">
                <select
                  className="select"
                  value={draft.hostId}
                  onChange={(e) => patchDraft({ hostId: e.target.value })}
                >
                  <option value="">{t("automations.selectHost")}</option>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label} ({h.username}@{h.host})
                    </option>
                  ))}
                </select>
                <button className="btn btn--ghost" onClick={props.onOpenSshSettings}>
                  {t("automations.manageHosts")}
                </button>
              </div>
            </SettingCard>
          </>
        )}
        <SettingCard title={t("automations.workspacePath")}>
          <div className="automations__row">
            <input
              className="input"
              value={draft.workspacePath}
              onChange={(e) => patchDraft({ workspacePath: e.target.value })}
            />
            {draft.targetKind === "local" && (
              <button
                className="btn btn--ghost"
                onClick={() =>
                  void window.deyin.workspace.openFolder().then((root) => {
                    if (root) patchDraft({ workspacePath: root });
                  })
                }
              >
                {t("automations.browse")}
              </button>
            )}
          </div>
        </SettingCard>

        <SectionTitle>{t("automations.section.model")}</SectionTitle>
        <SettingCard title={t("automations.provider")}>
          <select
            className="select"
            value={draft.providerId}
            disabled={draft.targetKind === "ssh"}
            onChange={(e) => patchDraft({ providerId: e.target.value })}
          >
            {providerOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </SettingCard>
        <SettingCard title={t("automations.model")}>
          <select className="select" value={draft.model} onChange={(e) => patchDraft({ model: e.target.value })}>
            {modelOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </SettingCard>

        {(runs.length > 0 || selectedActiveRunId) && (
          <>
            <SectionTitle>{t("automations.section.history")}</SectionTitle>
            <div className="automations__runs">
              {runs.map((run) => {
                const events = liveEvents[run.id] ?? run.events;
                const isActive = selectedActiveRunId === run.id;
                const text = events
                  .filter((e) => e.type === "text-delta")
                  .map((e) => (e.type === "text-delta" ? e.delta : ""))
                  .join("");
                const errors = events
                  .filter((e) => e.type === "error")
                  .map((e) => (e.type === "error" ? e.message : ""))
                  .join("\n");
                return (
                  <details key={run.id} className="automations__run" open={isActive}>
                    <summary>
                      {new Date(run.startedAt).toLocaleString()} — {t(statusKey(run.status))}
                      {isActive && ` (${t("automations.running")})`}
                      {run.reason ? ` · ${run.reason}` : ""}
                    </summary>
                    {errors && <pre className="automations__run-output automations__run-output--error">{errors}</pre>}
                    {text && <pre className="automations__run-output">{text.slice(-4000)}</pre>}
                    {run.finalText && !isActive && !text && (
                      <pre className="automations__run-output">{run.finalText.slice(-4000)}</pre>
                    )}
                  </details>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
