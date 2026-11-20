import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AutomationInfo,
  AutomationRun,
  CapabilityItem,
  EnvInfo,
  ModelInfo,
  SshHostInfo,
} from "@deyin/contract";
import { automationStatus, type AutomationStatus } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { draftToAutomationInput, type AutomationDraft } from "../automationDraft.js";
import { describeSchedule, formatNextRun } from "../automationFormat.js";
import { AnchoredMenu } from "./AnchoredMenu.js";
import { AutomationDetail, type WorkspaceChoice } from "./AutomationDetail.js";
import { useConfirm } from "./ConfirmDialog.js";
import { Icon } from "./Icon.js";

type StatusFilter = AutomationStatus | "all";

const FILTERS: readonly StatusFilter[] = ["active", "paused", "ended", "all"];

function filterLabelKey(filter: StatusFilter) {
  switch (filter) {
    case "active":
      return "automations.filter.active" as const;
    case "paused":
      return "automations.filter.paused" as const;
    case "ended":
      return "automations.filter.ended" as const;
    case "all":
      return "automations.filter.all" as const;
    default: {
      const unreachable: never = filter;
      return unreachable;
    }
  }
}

function emptyTitleKey(filter: StatusFilter) {
  switch (filter) {
    case "active":
      return "automations.empty.active" as const;
    case "paused":
      return "automations.empty.paused" as const;
    case "ended":
      return "automations.empty.ended" as const;
    case "all":
      return "automations.empty.all" as const;
    default: {
      const unreachable: never = filter;
      return unreachable;
    }
  }
}

function statusWordKey(status: Exclude<AutomationStatus, "active">) {
  return status === "paused" ? ("automations.status.paused" as const) : ("automations.status.ended" as const);
}

function payloadSummary(a: AutomationInfo): string {
  if (a.payload.kind === "skill") return `/${a.payload.skill}`;
  if (a.payload.kind === "subagent") return `@${a.payload.subagent}`;
  return a.payload.prompt;
}

/** Soonest first; tasks without a next run (manual, paused, ended) follow, newest edit first. */
function compareTasks(a: AutomationInfo, b: AutomationInfo): number {
  if (a.nextRunAt !== undefined && b.nextRunAt !== undefined) return a.nextRunAt - b.nextRunAt;
  if (a.nextRunAt !== undefined) return -1;
  if (b.nextRunAt !== undefined) return 1;
  return b.updatedAt - a.updatedAt;
}

interface Props {
  workspaceRoot: string | null;
  /** Folder-backed workspaces a task can run in. */
  workspaces: readonly WorkspaceChoice[];
  models: ModelInfo[];
  selectedModel: string;
  selectedProviderId: string;
  env: EnvInfo | null;
  onOpenSshSettings: () => void;
  /** Starts a new conversation with `prompt` in the composer, asking the agent to set the task up. */
  onCreateInSession: (prompt: string) => void;
}

function ScheduleIllustration() {
  return (
    <svg className="autos__illustration" width="110" height="110" viewBox="0 0 170 170" fill="none" aria-hidden="true" focusable="false">
      <path d="M163.819 97.9382C163.819 126.572 144.48 135.329 115.847 135.329C87.2129 135.329 60.1276 126.572 60.1276 97.9382C60.1276 69.3047 101.003 46.0927 129.637 46.0927C158.27 46.0927 163.819 69.3047 163.819 97.9382Z" className="autos__ill-bg" />
      <path d="M9.49521 88.6735C20.8278 111.218 39.5801 110.429 62.2137 99.0519C84.8474 87.6748 102.791 70.018 91.4589 47.4731C80.1263 24.9282 38.6291 22.8935 15.9955 34.2706C-6.63818 45.6478 -1.83735 66.1286 9.49521 88.6735Z" className="autos__ill-bg" />
      <path d="M25.2636 34.442C24.727 29.8132 28.0445 25.6258 32.6733 25.0893L101.373 17.126C106.002 16.5895 110.189 19.9069 110.726 24.5358L120.107 105.466C120.643 110.095 117.326 114.282 112.697 114.818L43.9972 122.782C39.3684 123.318 35.181 120.001 34.6445 115.372L25.2636 34.442Z" className="autos__ill-backing" />
      <path d="M40.169 25.1368C40.169 20.477 43.9466 16.6995 48.6064 16.6995H117.766C122.426 16.6995 126.204 20.477 126.204 25.1368V106.609C126.204 111.268 122.426 115.046 117.766 115.046H48.6064C43.9466 115.046 40.169 111.268 40.169 106.609V25.1368Z" className="autos__ill-surface" />
      <path d="M110.258 44.9883V50.3516H72.0831V44.9883H110.258Z" className="autos__ill-detail" />
      <path d="M110.258 63.2803V68.6436H72.0831V63.2803H110.258Z" className="autos__ill-detail" />
      <path d="M91.171 81.5713V86.9346H72.0831V81.5713H91.171Z" className="autos__ill-detail" />
      <path d="M56.1124 43.4998H64.0964V51.4838H56.1124V43.4998Z" className="autos__ill-detail" />
      <path d="M56.1124 61.97H64.0964V69.954H56.1124V61.97Z" className="autos__ill-detail" />
      <path d="M56.1124 80.2607H64.0964V88.2448H56.1124V80.2607Z" className="autos__ill-detail" />
      <path d="M149.05 98.8527C149.05 112.66 137.857 123.853 124.05 123.853C110.242 123.853 99.0496 112.66 99.0496 98.8527C99.0496 85.0455 110.242 73.8527 124.05 73.8527C137.857 73.8527 149.05 85.0455 149.05 98.8527Z" className="autos__ill-detail" />
      <path d="M144.192 98.8529C144.192 109.978 135.174 118.997 124.049 118.997C112.923 118.997 103.905 109.978 103.905 98.8529C103.905 87.7278 112.923 78.709 124.049 78.709C135.174 78.709 144.192 87.7278 144.192 98.8529Z" className="autos__ill-inset" />
      <path d="M125.124 86.7281L125.123 99.2824L134.923 104.132L132.824 108.375L122.76 103.395C121.309 102.677 120.39 101.197 120.39 99.5782L120.389 86.7275L125.124 86.7281Z" className="autos__ill-detail" />
    </svg>
  );
}

export function AutomationsView(props: Props) {
  const t = useT();
  const { confirm } = useConfirm();
  const api = window.deyin.automations;
  const sshApi = window.deyin.sshHosts;

  const [items, setItems] = useState<AutomationInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hosts, setHosts] = useState<SshHostInfo[]>([]);
  const [skills, setSkills] = useState<CapabilityItem[]>([]);
  const [subagents, setSubagents] = useState<CapabilityItem[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("active");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  /** automationId → active runId (supports concurrent runs without clobbering Stop). */
  const [activeByAutomation, setActiveByAutomation] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState<string | null>(null);

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const refresh = useCallback(async () => {
    if (!api) return;
    setItems(await api.list());
    setLoaded(true);
    if (sshApi) setHosts(await sshApi.list());
  }, [api, sshApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void window.deyin.caps.list("skill").then(setSkills);
    void window.deyin.caps.list("subagent").then(setSubagents);
  }, []);

  // The relative "in 3 hours" wording has to age while the page stays open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
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
          return prev.map((r) => (r.id === runId ? { ...r, status: liveStatus(event), events: [...r.events, event] } : r));
        }
        // Cron / background run: show it at once, but only in the task being looked at.
        const viewing = selectedIdRef.current;
        if (!viewing || !automationId || viewing !== automationId) return prev;
        return [{ id: runId, automationId, status: liveStatus(event), startedAt: Date.now(), events: [event] }, ...prev];
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
        if (selectedIdRef.current !== run.automationId) return without;
        return [run, ...without];
      });
      void refresh();
    });

    return () => {
      offEvent();
      offDone();
    };
  }, [api, refresh]);

  useEffect(() => {
    if (!selectedId || !api) {
      setRuns([]);
      return;
    }
    void api.runs(selectedId).then(setRuns);
  }, [selectedId, api]);

  const selected = useMemo(() => items.find((i) => i.id === selectedId) ?? null, [items, selectedId]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((item) => filter === "all" || automationStatus(item) === filter)
      .filter((item) => !q || [item.name, item.description ?? "", payloadSummary(item)].some((s) => s.toLowerCase().includes(q)))
      .sort(compareTasks);
  }, [items, filter, query]);

  const endedCount = useMemo(() => items.filter((i) => automationStatus(i) === "ended").length, [items]);

  const closeDetail = useCallback(() => {
    setSelectedId(null);
    setCreating(false);
  }, []);

  const openCreate = useCallback(() => {
    setSelectedId(null);
    setCreating(true);
  }, []);

  const save = useCallback(
    async (draft: AutomationDraft) => {
      if (!api) return;
      const input = draftToAutomationInput(draft);
      if (creating || !selected) {
        const result = await api.create(input);
        setItems(result.list);
        setCreating(false);
        setQuery("");
        setFilter("all");
        setSelectedId(result.automation.id);
        return;
      }
      // Re-sending an unchanged one-shot trigger would re-arm a task that already ran.
      const { trigger, ...rest } = input;
      const sameTrigger = JSON.stringify(trigger) === JSON.stringify(selected.trigger);
      const result = await api.update(selected.id, sameTrigger ? rest : input);
      setItems(result.list);
    },
    [api, creating, selected],
  );

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 6000);
  }, []);

  const toggle = useCallback(
    async (task: AutomationInfo) => {
      if (!api) return;
      try {
        setItems(await api.toggle(task.id, !task.enabled));
      } catch (err) {
        flash(err instanceof Error ? err.message : String(err));
      }
    },
    [api, flash],
  );

  const runNow = useCallback(
    async (task: AutomationInfo) => {
      if (!api) return;
      try {
        const run = await api.run(task.id);
        setActiveByAutomation((prev) => ({ ...prev, [task.id]: run.id }));
      } catch (err) {
        flash(err instanceof Error ? err.message : String(err));
      }
    },
    [api, flash],
  );

  const remove = useCallback(
    async (task: AutomationInfo) => {
      if (!api) return;
      const ok = await confirm({
        title: t("automations.deleteTitle"),
        message: task.name,
        confirmLabel: t("automations.delete"),
        destructive: true,
      });
      if (!ok) return;
      setItems(await api.remove(task.id));
      closeDetail();
    },
    [api, confirm, t, closeDetail],
  );

  if (!api) {
    return (
      <section className="autos">
        <div className="autos__list-pane">
          <div className="autos__scroll">
            <div className="autos__content">
              <div className="autos__empty">
                <Icon name="automation" size={24} className="autos__empty-glyph" />
                <h2>{t("automations.title")}</h2>
                <p>{t("automations.desktopOnly")}</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const detailOpen = creating || selected !== null;
  const emptyKey = query.trim() && items.length > 0 ? "automations.empty.noMatches" : emptyTitleKey(filter);

  return (
    <section
      className={`autos${detailOpen ? " autos--has-detail" : ""}`}
      aria-label={t("automations.page.title")}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !detailOpen) return;
        event.preventDefault();
        closeDetail();
      }}
    >
      <div className="autos__list-pane">
        <div className="autos__scroll">
          <div className="autos__content">
            <div className="autos__heading">
              <h1>{t("automations.page.title")}</h1>
              <span className="autos__create" role="group" aria-label={t("automations.page.new")}>
                <button type="button" className="autos__create-main" onClick={() => props.onCreateInSession(t("automations.page.sessionPrompt"))}>
                  <Icon name="plus" size={13} />
                  {t("automations.page.new")}
                </button>
                <AnchoredMenu
                  open={createMenuOpen}
                  onToggle={() => setCreateMenuOpen((v) => !v)}
                  onClose={() => setCreateMenuOpen(false)}
                  triggerClassName="autos__create-more"
                  triggerTitle={t("automations.page.createMethod")}
                  panelClassName="rule-menu"
                  trigger={<Icon name="chevronDown" size={12} />}
                >
                  <button
                    type="button"
                    className="rule-menu__item"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      props.onCreateInSession(t("automations.page.sessionPrompt"));
                    }}
                  >
                    <Icon name="message" size={14} />
                    <span className="rule-menu__label">{t("automations.page.createInSession")}</span>
                  </button>
                  <button
                    type="button"
                    className="rule-menu__item"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      openCreate();
                    }}
                  >
                    <Icon name="pencil" size={14} />
                    <span className="rule-menu__label">{t("automations.page.createManually")}</span>
                  </button>
                </AnchoredMenu>
              </span>
            </div>

            <div className="autos__filters" role="group" aria-label={t("automations.page.title")}>
              {FILTERS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`autos__filter${filter === value ? " autos__filter--active" : ""}`}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {t(filterLabelKey(value))}
                </button>
              ))}
            </div>

            <div className="autos__search">
              <Icon name="search" size={14} />
              <input
                type="search"
                aria-label={t("automations.search.placeholder")}
                placeholder={t("automations.search.placeholder")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query !== "" && (
                <button
                  type="button"
                  className="icon-btn icon-btn--small"
                  aria-label={t("automations.search.clear")}
                  onClick={() => setQuery("")}
                >
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>

            {notice && (
              <p className="autos__notice" role="alert">
                {notice}
              </p>
            )}

            {loaded && rows.length === 0 && (
              <div className="autos__empty" role="status">
                <ScheduleIllustration />
                <h2>{t(emptyKey)}</h2>
                {items.length === 0 && (
                  <button type="button" className="btn btn--outline autos__empty-action" onClick={openCreate}>
                    {t("automations.empty.action")}
                  </button>
                )}
              </div>
            )}

            <ul className="autos__rows" aria-label={t("automations.page.title")}>
              {rows.map((item) => {
                const status = automationStatus(item);
                const running = activeByAutomation[item.id] !== undefined;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`autos__row${selectedId === item.id ? " autos__row--selected" : ""}${status !== "active" ? " autos__row--inactive" : ""}`}
                      aria-expanded={selectedId === item.id}
                      onClick={() => {
                        setCreating(false);
                        setSelectedId(item.id);
                      }}
                    >
                      <Icon name="clock" size={16} className="autos__row-glyph" />
                      <span className="autos__row-content">
                        <span className="autos__row-title">{item.name}</span>
                        <span className="autos__row-summary">
                          {running && <span className="autos__meta">{t("automations.runningNow")}</span>}
                          {status !== "active" && <span className="autos__meta">{t(statusWordKey(status))}</span>}
                          <span className="autos__meta">
                            {item.trigger.kind === "once" && status === "active"
                              ? t("automations.repeat.once")
                              : describeSchedule(item.trigger, t)}
                          </span>
                          {status === "active" && item.nextRunAt !== undefined && (
                            <span className="autos__meta">
                              {t("automations.nextPrefix")} {formatNextRun(item.nextRunAt, now)}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {filter !== "active" && endedCount > 0 && (
              <p className="autos__footnote">
                <button
                  type="button"
                  className="autos__link"
                  onClick={() => {
                    void (async () => {
                      const ok = await confirm({
                        title: t("automations.clearEnded.title"),
                        message: t("automations.clearEnded.description"),
                        confirmLabel: t("automations.clearEnded.action"),
                        destructive: true,
                      });
                      if (!ok) return;
                      const ended = items.filter((i) => automationStatus(i) === "ended");
                      let list = items;
                      for (const task of ended) list = await api.remove(task.id);
                      setItems(list);
                      if (selectedId && ended.some((i) => i.id === selectedId)) closeDetail();
                    })();
                  }}
                >
                  {t("automations.clearEnded.action")}
                </button>
              </p>
            )}
          </div>
        </div>
      </div>

      {detailOpen && (
        <AutomationDetail
          key={creating ? "new" : selected?.id}
          task={creating ? null : selected}
          workspaces={props.workspaces}
          defaultWorkspace={props.workspaceRoot ?? props.workspaces[0]?.root ?? ""}
          models={props.models}
          selectedModel={props.selectedModel}
          selectedProviderId={props.selectedProviderId}
          env={props.env}
          hosts={hosts}
          skills={skills}
          subagents={subagents}
          runs={runs}
          activeRunId={selected ? (activeByAutomation[selected.id] ?? null) : null}
          now={now}
          onSave={save}
          onClose={closeDetail}
          onToggle={(task) => void toggle(task)}
          onRun={(task) => void runNow(task)}
          onStop={(runId) => api.stop(runId)}
          onDelete={(task) => void remove(task)}
          onSetAutoHeal={async (task, enabled) => {
            setItems((await api.update(task.id, { autoHeal: enabled })).list);
          }}
          onRevertLearned={async (task, revisionId) => {
            setItems(await api.revertLearned(task.id, revisionId));
          }}
          onOpenSshSettings={props.onOpenSshSettings}
          onProbeWsl={async (distro) => {
            const result = await api.testWsl(distro);
            return result.ok
              ? `${result.message} (node ${result.nodeVersion}, deyin ${result.deyinVersion})`
              : result.message;
          }}
        />
      )}
    </section>
  );
}
