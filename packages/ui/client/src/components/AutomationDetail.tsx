import { useMemo, useState, type ReactNode } from "react";
import type {
  AutomationInfo,
  AutomationRun,
  CapabilityItem,
  EnvInfo,
  ModelInfo,
  SshHostInfo,
} from "@deyin/contract";
import { useT } from "../i18n.js";
import {
  draftChanged,
  draftFromAutomation,
  draftIssues,
  emptyDraft,
  type AutomationDraft,
  type PayloadKind,
  type TargetKind,
} from "../automationDraft.js";
import { describeTimeZone, formatNextRun } from "../automationFormat.js";
import { scheduleToTrigger, type RepeatKind, type ScheduleDraft } from "../automationSchedule.js";
import { automationStatus } from "@deyin/host-core/shared";
import { AnchoredMenu } from "./AnchoredMenu.js";
import { RuleRow, RuleStepper, RuleTimeInput, RuleWeekdayRow } from "./AutomationRuleControls.js";
import { Icon } from "./Icon.js";
import { RuleSelect, type RuleOption } from "./RuleSelect.js";

export interface WorkspaceChoice {
  name: string;
  root: string;
}

interface Props {
  /** The saved task being viewed; null while creating a new one. */
  task: AutomationInfo | null;
  workspaces: readonly WorkspaceChoice[];
  defaultWorkspace: string;
  models: readonly ModelInfo[];
  selectedModel: string;
  selectedProviderId: string;
  env: EnvInfo | null;
  hosts: readonly SshHostInfo[];
  skills: readonly CapabilityItem[];
  subagents: readonly CapabilityItem[];
  runs: readonly AutomationRun[];
  /** Id of the run in flight for this task, if any. */
  activeRunId: string | null;
  now: number;
  /** Persist the draft; rejects with the reason it was refused. */
  onSave: (draft: AutomationDraft) => Promise<void>;
  onClose: () => void;
  onToggle: (task: AutomationInfo) => void;
  onRun: (task: AutomationInfo) => void;
  onStop: (runId: string) => void;
  onDelete: (task: AutomationInfo) => void;
  onOpenSshSettings: () => void;
  onProbeWsl: (distro: string) => Promise<string>;
}

type Tab = "rules" | "records";

const REPEAT_ORDER: readonly RepeatKind[] = [
  "weekly",
  "weekdays",
  "daily",
  "hourly",
  "minutely",
  "monthly",
  "once",
  "manual",
  "custom",
];

function repeatLabelKey(kind: RepeatKind) {
  switch (kind) {
    case "weekly":
      return "automations.repeat.weekly" as const;
    case "weekdays":
      return "automations.repeat.weekdays" as const;
    case "daily":
      return "automations.repeat.daily" as const;
    case "hourly":
      return "automations.repeat.hourly" as const;
    case "minutely":
      return "automations.repeat.minutely" as const;
    case "monthly":
      return "automations.repeat.monthly" as const;
    case "once":
      return "automations.repeat.once" as const;
    case "manual":
      return "automations.repeat.manual" as const;
    case "custom":
      return "automations.repeat.custom" as const;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
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
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function AutomationDetail(props: Props) {
  const t = useT();
  const { task } = props;
  const [initial] = useState(() => emptyDraft(props.defaultWorkspace, props.selectedModel, props.selectedProviderId));
  const base = useMemo(() => (task ? draftFromAutomation(task) : initial), [task, initial]);
  const [draft, setDraft] = useState<AutomationDraft>(base);
  const [tab, setTab] = useState<Tab>("rules");
  const [advancedOpen, setAdvancedOpen] = useState(base.payloadKind !== "prompt" || base.targetKind !== "local");
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);

  const change = (patch: Partial<AutomationDraft>) => {
    setError(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  };
  const changeSchedule = (patch: Partial<ScheduleDraft>) => change({ schedule: { ...draft.schedule, ...patch } });

  const dirty = draftChanged(draft, base);
  const issues = draftIssues(draft, props.now);
  // A stored once-time that has already passed is only a problem when the user picks it again.
  if (task && JSON.stringify(scheduleToTrigger(draft.schedule)) === JSON.stringify(task.trigger)) delete issues.schedule;
  const valid = Object.keys(issues).length === 0;
  const hint = issues.schedule ?? issues.skill ?? issues.subagent ?? issues.hostId ?? issues.distro ?? issues.workspacePath;

  const status = task ? automationStatus(task) : "active";
  const running = props.activeRunId !== null;
  const zone = describeTimeZone(new Date(props.now));
  const schedule = draft.schedule;
  const rowId = (name: string) => `autos-${name}`;

  const save = async () => {
    if (saving || !valid) return;
    setSaving(true);
    setError(null);
    try {
      await props.onSave(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const repeatOptions: RuleOption[] = REPEAT_ORDER.map((kind) => ({ id: kind, label: t(repeatLabelKey(kind)) }));

  const workspaceOptions: RuleOption[] = props.workspaces.map((w) => ({ id: w.root, label: w.name, hint: w.root }));
  if (draft.workspacePath && !workspaceOptions.some((o) => o.id === draft.workspacePath)) {
    const leaf = draft.workspacePath.replace(/\\/g, "/").split("/").filter(Boolean).pop();
    workspaceOptions.unshift({ id: draft.workspacePath, label: leaf ?? draft.workspacePath, hint: draft.workspacePath });
  }

  const modelOptions: RuleOption[] = props.models
    .filter((m) => m.kind !== "image" && m.kind !== "video")
    .map((m) => ({ id: m.id, label: m.name || m.id }));
  if (draft.model && !modelOptions.some((o) => o.id === draft.model)) modelOptions.unshift({ id: draft.model, label: draft.model });

  const capabilityOptions = (items: readonly CapabilityItem[]): RuleOption[] =>
    items.map((c) => ({ id: c.name, label: c.enabled ? c.name : `${c.name} (${t("automations.disabled")})`, hint: c.description || undefined }));

  const targetOptions: RuleOption[] = [{ id: "local", label: t("automations.target.local") }];
  if ((props.env?.wslDistros ?? []).length > 0 || draft.targetKind === "wsl") {
    targetOptions.push({ id: "wsl", label: t("automations.target.wsl") });
  }
  targetOptions.push({ id: "ssh", label: t("automations.target.ssh") });

  const payloadOptions: RuleOption[] = [
    { id: "prompt", label: t("automations.payload.prompt") },
    { id: "skill", label: t("automations.payload.skill") },
    { id: "subagent", label: t("automations.payload.subagent") },
  ];

  const hourlyMinute = Number(schedule.time.split(":")[1] ?? "0");
  const ranges: ReactNode = (
    <>
      <RuleSelect
        label={t("automations.field.repeat")}
        value={schedule.repeat}
        options={repeatOptions}
        onChange={(id) => changeSchedule({ repeat: id as RepeatKind })}
      />
      {(schedule.repeat === "daily" || schedule.repeat === "hourly" || schedule.repeat === "minutely") && (
        <RuleRow label={t("automations.field.interval")} htmlFor={rowId("interval")}>
          <RuleStepper
            id={rowId("interval")}
            min={1}
            max={9999}
            value={Number(schedule.interval) || 1}
            onChange={(value) => changeSchedule({ interval: String(value) })}
          />
        </RuleRow>
      )}
      {schedule.repeat === "weekly" && (
        <RuleWeekdayRow
          weekdays={schedule.weekdays}
          onToggle={(day) =>
            changeSchedule({
              weekdays: schedule.weekdays.includes(day)
                ? schedule.weekdays.filter((d) => d !== day)
                : [...schedule.weekdays, day].sort((a, b) => a - b),
            })
          }
        />
      )}
      {schedule.repeat === "monthly" && (
        <RuleRow label={t("automations.field.monthDay")} htmlFor={rowId("monthDay")}>
          <RuleStepper
            id={rowId("monthDay")}
            min={1}
            max={31}
            value={schedule.monthDay}
            onChange={(value) => changeSchedule({ monthDay: value })}
          />
        </RuleRow>
      )}
      {schedule.repeat === "once" && (
        <RuleRow label={t("automations.field.date")} htmlFor={rowId("date")}>
          <input
            id={rowId("date")}
            className="rule-input"
            type="date"
            value={schedule.date}
            onChange={(event) => changeSchedule({ date: event.target.value })}
          />
        </RuleRow>
      )}
      {(schedule.repeat === "weekly" ||
        schedule.repeat === "weekdays" ||
        schedule.repeat === "daily" ||
        schedule.repeat === "monthly" ||
        schedule.repeat === "once") && (
        <RuleRow label={t("automations.field.time")} htmlFor={rowId("time")}>
          <RuleTimeInput id={rowId("time")} value={schedule.time} onChange={(time) => changeSchedule({ time })} />
        </RuleRow>
      )}
      {schedule.repeat === "hourly" && (
        <RuleRow label={t("automations.field.minute")} htmlFor={rowId("minute")}>
          <RuleStepper
            id={rowId("minute")}
            min={0}
            max={59}
            value={Number.isFinite(hourlyMinute) ? hourlyMinute : 0}
            onChange={(minute) => changeSchedule({ time: `${schedule.time.split(":")[0] ?? "00"}:${pad2(minute)}` })}
          />
        </RuleRow>
      )}
      {schedule.repeat === "custom" && (
        <RuleRow label={t("automations.cron")} htmlFor={rowId("cron")}>
          <input
            id={rowId("cron")}
            className="rule-input rule-input--mono"
            value={schedule.cron}
            spellCheck={false}
            onChange={(event) => changeSchedule({ cron: event.target.value })}
          />
        </RuleRow>
      )}
      {schedule.repeat !== "manual" && (
        <div className="rule-row">
          <span className="rule-row__label">{t("automations.field.zone")}</span>
          <span className="rule-value rule-value--disabled">
            <span className="rule-value__text">{zone}</span>
          </span>
        </div>
      )}
    </>
  );

  const headerActions = (
    <div className="autos-detail__actions">
      {task && (
        <>
          <button
            type="button"
            className="icon-btn icon-btn--small"
            title={t(status === "active" ? "automations.pause" : "automations.resume")}
            aria-label={t(status === "active" ? "automations.pause" : "automations.resume")}
            disabled={dirty || status === "ended"}
            onClick={() => props.onToggle(task)}
          >
            <Icon name={status === "active" ? "pause" : "play"} size={14} />
          </button>
          <AnchoredMenu
            open={menuOpen}
            onToggle={() => setMenuOpen((v) => !v)}
            onClose={() => setMenuOpen(false)}
            triggerClassName="icon-btn icon-btn--small"
            triggerTitle={t("automations.more")}
            panelClassName="rule-menu"
            trigger={<Icon name="dots" size={14} />}
          >
            {running && props.activeRunId ? (
              <button
                type="button"
                className="rule-menu__item"
                onClick={() => {
                  setMenuOpen(false);
                  if (props.activeRunId) props.onStop(props.activeRunId);
                }}
              >
                <span className="rule-menu__label">{t("automations.stop")}</span>
              </button>
            ) : (
              <button
                type="button"
                className="rule-menu__item"
                disabled={dirty}
                onClick={() => {
                  setMenuOpen(false);
                  props.onRun(task);
                }}
              >
                <span className="rule-menu__label">{t("automations.runNow")}</span>
              </button>
            )}
            <button
              type="button"
              className="rule-menu__item rule-menu__item--danger"
              onClick={() => {
                setMenuOpen(false);
                props.onDelete(task);
              }}
            >
              <span className="rule-menu__label">{t("automations.delete")}</span>
            </button>
          </AnchoredMenu>
        </>
      )}
      <button
        type="button"
        className="icon-btn icon-btn--small"
        title={t("automations.close")}
        aria-label={t("automations.close")}
        onClick={props.onClose}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );

  return (
    <aside className="autos-detail" aria-label={t(task ? "automations.title" : "automations.drawer.create")}>
      <div className="autos-detail__bar">
        {task ? (
          <div className="autos-detail__tabs" role="tablist">
            {(["rules", "records"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className="autos-detail__tab"
                onClick={() => setTab(value)}
              >
                {t(value === "rules" ? "automations.drawer.rules" : "automations.drawer.records")}
              </button>
            ))}
          </div>
        ) : (
          <h2 className="autos-detail__create-title">{t("automations.drawer.create")}</h2>
        )}
        {headerActions}
      </div>

      <div className={`autos-detail__scroll${tab === "records" ? " autos-detail__scroll--records" : ""}`}>
        {tab === "rules" && (
          <>
            {task && (
              <>
                <h2 className="autos-detail__name">{task.name}</h2>
                <p className="autos-detail__next">
                  {status === "active" && task.nextRunAt
                    ? `${t("automations.drawer.nextRun")} ${formatNextRun(task.nextRunAt, props.now)}`
                    : status === "active"
                      ? t("automations.freq.manual")
                      : t(status === "paused" ? "automations.status.paused" : "automations.status.ended")}
                </p>
                {running && <p className="autos-detail__notice">{t("automations.runningNow")}</p>}
              </>
            )}
            <div className="autos-editor">
              <label className="autos-editor__field">
                {t("automations.field.name")}
                <input
                  className="autos-editor__input"
                  value={draft.name}
                  maxLength={120}
                  placeholder={t("automations.field.namePlaceholder")}
                  onChange={(event) => change({ name: event.target.value })}
                />
              </label>
              {draft.payloadKind === "prompt" && (
                <label className="autos-editor__field">
                  {t("automations.field.instruction")}
                  <textarea
                    className="autos-editor__instruction"
                    value={draft.prompt}
                    placeholder={t("automations.field.instructionPlaceholder")}
                    onChange={(event) => change({ prompt: event.target.value })}
                  />
                </label>
              )}

              <div className="rule-rows">
                {draft.targetKind === "local" ? (
                  <RuleSelect
                    label={t("automations.field.workspace")}
                    value={draft.workspacePath}
                    options={workspaceOptions}
                    placeholder={t("automations.field.chooseWorkspace")}
                    onChange={(id) => change({ workspacePath: id })}
                    action={{
                      label: t("automations.browse"),
                      onSelect: () => {
                        void window.deyin.workspace.openFolder(draft.workspacePath || undefined).then((picked) => {
                          if (picked) change({ workspacePath: picked });
                        });
                      },
                    }}
                  />
                ) : (
                  <RuleRow label={t("automations.workspacePath")} htmlFor={rowId("path")}>
                    <input
                      id={rowId("path")}
                      className="rule-input rule-input--mono"
                      value={draft.workspacePath}
                      spellCheck={false}
                      onChange={(event) => change({ workspacePath: event.target.value })}
                    />
                  </RuleRow>
                )}
              </div>

              <section className="autos-editor__field" aria-label={t("automations.field.runTime")}>
                <h3>{t("automations.field.runTime")}</h3>
                <div className="rule-rows">{ranges}</div>
              </section>

              <section className="autos-editor__field">
                <button
                  type="button"
                  className="autos-editor__advanced"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((v) => !v)}
                >
                  <Icon name="chevronRight" size={12} className={advancedOpen ? "autos-editor__chev autos-editor__chev--open" : "autos-editor__chev"} />
                  {t("automations.field.advanced")}
                </button>
                {advancedOpen && (
                  <div className="rule-rows">
                    <RuleSelect
                      label={t("automations.payloadKind")}
                      value={draft.payloadKind}
                      options={payloadOptions}
                      onChange={(id) => change({ payloadKind: id as PayloadKind })}
                    />
                    {draft.payloadKind === "skill" && (
                      <RuleSelect
                        label={t("automations.skill")}
                        value={draft.skill}
                        options={capabilityOptions(props.skills)}
                        placeholder={t("automations.selectCapability")}
                        onChange={(id) => change({ skill: id })}
                      />
                    )}
                    {draft.payloadKind === "subagent" && (
                      <RuleSelect
                        label={t("automations.subagent")}
                        value={draft.subagent}
                        options={capabilityOptions(props.subagents)}
                        placeholder={t("automations.selectCapability")}
                        onChange={(id) => change({ subagent: id })}
                      />
                    )}
                    {draft.payloadKind !== "prompt" && (
                      <RuleRow label={t("automations.capabilityInput")} htmlFor={rowId("args")}>
                        <input
                          id={rowId("args")}
                          className="rule-input"
                          value={draft.capabilityInput}
                          onChange={(event) => change({ capabilityInput: event.target.value })}
                        />
                      </RuleRow>
                    )}
                    <RuleSelect
                      label={t("automations.model")}
                      value={draft.model}
                      options={modelOptions}
                      onChange={(id) => change({ model: id })}
                    />
                    <RuleSelect
                      label={t("automations.targetKind")}
                      value={draft.targetKind}
                      options={targetOptions}
                      onChange={(id) => {
                        setProbe(null);
                        change({ targetKind: id as TargetKind });
                      }}
                    />
                    {draft.targetKind === "wsl" && (
                      <RuleSelect
                        label={t("automations.distro")}
                        value={draft.distro}
                        options={(props.env?.wslDistros ?? []).map((d) => ({ id: d, label: d }))}
                        placeholder={t("automations.selectDistro")}
                        onChange={(id) => {
                          setProbe(null);
                          change({ distro: id });
                        }}
                      />
                    )}
                    {draft.targetKind === "ssh" && (
                      <RuleSelect
                        label={t("automations.sshHost")}
                        value={draft.hostId}
                        options={props.hosts.map((h) => ({ id: h.id, label: h.label, hint: `${h.username}@${h.host}` }))}
                        placeholder={t("automations.selectHost")}
                        onChange={(id) => change({ hostId: id })}
                        action={{ label: t("automations.manageHosts"), onSelect: props.onOpenSshSettings }}
                      />
                    )}
                    <RuleRow label={t("automations.description")} htmlFor={rowId("description")}>
                      <input
                        id={rowId("description")}
                        className="rule-input"
                        value={draft.description}
                        placeholder={t("automations.descriptionPlaceholder")}
                        onChange={(event) => change({ description: event.target.value })}
                      />
                    </RuleRow>
                  </div>
                )}
                {advancedOpen && draft.targetKind === "wsl" && draft.distro && (
                  <p className="autos-detail__notice">
                    <button
                      type="button"
                      className="autos-detail__link"
                      onClick={() => {
                        setProbe("…");
                        void props.onProbeWsl(draft.distro).then(setProbe);
                      }}
                    >
                      {t("automations.test")}
                    </button>{" "}
                    {probe ?? t("automations.distroDesc")}
                  </p>
                )}
                {advancedOpen && draft.targetKind !== "local" && (
                  <p className="autos-detail__notice">{t("automations.sshOpenferenceOnly")}</p>
                )}
              </section>
              {error ? (
                <p className="autos-detail__failure" role="alert">
                  {error}
                </p>
              ) : (
                hint && (
                  <p className="autos-detail__failure" role="status">
                    {t(hint)}
                  </p>
                )
              )}
            </div>
          </>
        )}

        {tab === "records" && task && <RunRecords runs={props.runs} />}
      </div>

      {tab === "rules" && (
        <footer className="autos-detail__footer">
          <span className="autos-detail__footnote">{dirty ? t("automations.unsaved") : ""}</span>
          <button
            type="button"
            className="btn btn--outline"
            disabled={saving || (task !== null && !dirty)}
            onClick={() => {
              setError(null);
              setProbe(null);
              if (task) setDraft(base);
              else props.onClose();
            }}
          >
            {t("automations.discard")}
          </button>
          <button type="button" className="btn btn--primary" disabled={saving || !dirty || !valid} onClick={() => void save()}>
            {t(saving ? (task ? "automations.saving" : "automations.creating") : task ? "automations.save" : "automations.create")}
          </button>
        </footer>
      )}
    </aside>
  );
}

function RunRecords({ runs }: { runs: readonly AutomationRun[] }) {
  const t = useT();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (runs.length === 0) return <p className="autos-detail__empty">{t("automations.noRuns")}</p>;
  return (
    <ol className="autos-records">
      {runs.map((run) => {
        const text = run.finalText?.trim() ?? "";
        const open = expanded[run.id] === true;
        return (
          <li key={run.id} className="autos-record">
            <Icon name="clock" size={16} className="autos-record__glyph" />
            <div className="autos-record__body">
              <div className="autos-record__head">
                <time className="autos-record__time">{new Date(run.startedAt).toLocaleString()}</time>
                <span className={`run-pill run-pill--${run.status}`}>
                  <span className="run-pill__dot" />
                  {t(statusKey(run.status))}
                </span>
              </div>
              {run.reason && <p className="autos-record__reason">{run.reason}</p>}
              {text ? (
                <>
                  <p className={`autos-record__text${open ? " autos-record__text--open" : ""}`}>{text.slice(0, 4000)}</p>
                  {text.length > 120 && (
                    <button
                      type="button"
                      className="autos-record__toggle"
                      onClick={() => setExpanded((prev) => ({ ...prev, [run.id]: !open }))}
                    >
                      {t(open ? "automations.records.less" : "automations.records.more")}
                    </button>
                  )}
                </>
              ) : (
                run.status !== "running" &&
                run.status !== "queued" && <p className="autos-record__text">{t("automations.records.noOutput")}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
