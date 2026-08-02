import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { threadPreview } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { ContextUsage } from "./ContextUsage.js";
import { Icon, type IconName } from "./Icon.js";
import { ModelPicker } from "./ModelPicker.js";
import type {
  ApprovalMode,
  ChatMode,
  ContextAttachment,
  ContextSearchHit,
  ContextUsageSnapshot,
  LinkedThreadRef,
  ModelInfo,
  Thread,
} from "../../shared/types.js";

interface ComposerProps {
  value: string;
  models: ModelInfo[];
  selectedModel: string;
  approvalMode: ApprovalMode;
  /** Composer mode (Agent/Plan/Ask); hidden when undefined (e.g. web plain chat). */
  mode?: ChatMode;
  /** When false, Delivery mode is hidden from the mode switcher. */
  deliveryModeEnabled?: boolean;
  thinking: boolean;
  canSend: boolean;
  streaming: boolean;
  /** Follow-up queued while a run is active. */
  queuedPrompt?: string | null;
  hasEvents: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Abort current run and send immediately (Cursor-like interrupt). */
  onSendNow?: () => void;
  onClearQueue?: () => void;
  /** When set and streaming, a stop button is shown. */
  onStop?: () => void;
  onSelectModel: (id: string) => void;
  onSelectApproval: (mode: ApprovalMode) => void;
  onSelectMode?: (mode: ChatMode) => void;
  onToggleThinking: (on: boolean) => void;
  onManageModels?: () => void;
  providers?: import("../../shared/types.js").ProviderInfo[];
  selectedProviderId?: string;
  onSelectProviderModel?: (providerId: string, modelId: string) => void;
  /** Live context-window fill for the active thread. */
  contextSnapshot?: ContextUsageSnapshot | null;
  /** Fallback context window from the selected model. */
  contextLength?: number;
  /** Active thread id — resets the Context Usage popover on switch. */
  threadKey?: string | null;
  /** Run status from event-sourced agent state. */
  runStatus?: { phase: string; label: string; retryCount: number; maxRetries: number; workDurationMs: number } | null;
  /** Soft compaction warning from the agent loop (50% context threshold). */
  compactionNotice?: string | null;
  attachments?: ContextAttachment[];
  onAttachmentsChange?: (next: ContextAttachment[]) => void;
  linkedThreads?: LinkedThreadRef[];
  onLinkedThreadsChange?: (next: LinkedThreadRef[]) => void;
  /** Other threads in the project for # linking. */
  threadsForPicker?: Thread[];
  activeThreadId?: string | null;
  workspaceRoot?: string | null;
  goalText?: string | null;
  onSetGoal?: (text: string | null) => void;
}

const APPROVAL_META: Record<ApprovalMode, { label: string; icon: "shield" | "hand" | "eye" }> = {
  "full-access": { label: "Full access", icon: "shield" },
  "ask-first": { label: "Ask before changes", icon: "hand" },
  "read-only": { label: "Read only", icon: "eye" },
};

const MODE_ORDER: ChatMode[] = ["agent", "delivery", "plan", "ask"];
const MODE_META: Record<
  ChatMode,
  {
    labelKey: "mode.agent" | "mode.delivery" | "mode.plan" | "mode.ask";
    descKey: "mode.agentDesc" | "mode.deliveryDesc" | "mode.planDesc" | "mode.askDesc";
    icon: IconName;
  }
> = {
  agent: { labelKey: "mode.agent", descKey: "mode.agentDesc", icon: "bolt" },
  delivery: { labelKey: "mode.delivery", descKey: "mode.deliveryDesc", icon: "shield" },
  plan: { labelKey: "mode.plan", descKey: "mode.planDesc", icon: "route" },
  ask: { labelKey: "mode.ask", descKey: "mode.askDesc", icon: "message" },
};

interface SlashItem {
  name: string;
  description: string;
}

export function Composer(props: ComposerProps) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement>(null);
  const modeOrder = useMemo(
    () => (props.deliveryModeEnabled === false ? MODE_ORDER.filter((m) => m !== "delivery") : MODE_ORDER),
    [props.deliveryModeEnabled],
  );
  const [plusOpen, setPlusOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [slashItems, setSlashItems] = useState<SlashItem[]>([]);
  const [atHits, setAtHits] = useState<ContextSearchHit[]>([]);
  const [hashHits, setHashHits] = useState<LinkedThreadRef[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const attachments = props.attachments ?? [];
  const linkedThreads = props.linkedThreads ?? [];
  const [goalOpen, setGoalOpen] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");

  const attachmentEstimateTokens = useMemo(
    () =>
      Math.round(
        attachments.reduce(
          (sum, a) => sum + Math.max(2_000, (a.path.length + (a.label?.length ?? 0)) * 80),
          0,
        ) / 4,
      ),
    [attachments],
  );
  const contextLimit = props.contextLength ?? props.contextSnapshot?.contextLength ?? 0;
  const attachmentHeavy =
    attachmentEstimateTokens > 0 && contextLimit > 0 && attachmentEstimateTokens / contextLimit > 0.5;

  const cycleMode = () => {
    if (!props.mode || !props.onSelectMode) return;
    const next = modeOrder[(modeOrder.indexOf(props.mode!) + 1) % modeOrder.length]!;
    props.onSelectMode(next);
  };

  // Ctrl/Cmd+. opens the mode menu from anywhere (Cursor's Mode Menu binding).
  useEffect(() => {
    if (!props.mode) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ".") {
        e.preventDefault();
        setModeOpen((v) => !v);
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.mode]);

  // Escape closes goal modal
  useEffect(() => {
    if (!goalOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setGoalOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [goalOpen]);

  // Slash autocomplete sources: commands plus skills (invocable as /skill-name).
  useEffect(() => {
    let alive = true;
    void Promise.all([window.deyin.caps.list("command"), window.deyin.caps.list("skill")])
      .then(([commands, skills]) => {
        if (!alive) return;
        const byName = new Map<string, SlashItem>();
        for (const c of commands.filter((c) => c.enabled)) {
          byName.set(c.name.replace(/^\//, ""), { name: c.name.replace(/^\//, ""), description: c.description });
        }
        for (const s of skills.filter((s) => s.enabled)) {
          if (!byName.has(s.name)) byName.set(s.name, { name: s.name, description: `Skill · ${s.description}` });
        }
        setSlashItems([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const slashMatches = (() => {
    if (!props.value.startsWith("/") || props.value.includes("\n") || props.value.includes(" ")) return [];
    const query = props.value.slice(1).toLowerCase();
    return slashItems.filter((i) => i.name.startsWith(query)).slice(0, 8);
  })();

  const atQuery = (() => {
    const m = props.value.match(/@([^\s@]*)$/);
    return m ? m[1]! : null;
  })();

  const hashQuery = (() => {
    const m = props.value.match(/#([^\s#]*)$/);
    return m ? m[1]! : null;
  })();

  useEffect(() => {
    if (atQuery === null || !props.workspaceRoot) {
      setAtHits([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void window.deyin.context.search(atQuery).then((hits) => {
        if (alive) setAtHits(hits);
      });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [atQuery, props.workspaceRoot]);

  useEffect(() => {
    if (hashQuery === null) {
      setHashHits([]);
      return;
    }
    const q = hashQuery.toLowerCase();
    const pool =
      props.threadsForPicker?.filter((t) => t.id !== props.activeThreadId && !t.archived) ?? [];
    setHashHits(
      pool
        .filter((t) => t.title.toLowerCase().includes(q) || t.id.includes(q))
        .slice(0, 8)
        .map((t) => ({ threadId: t.id, title: t.title, preview: threadPreview(t.events) })),
    );
  }, [hashQuery, props.threadsForPicker, props.activeThreadId]);

  const addAttachment = useCallback(
    (hit: ContextSearchHit) => {
      if (!props.onAttachmentsChange) return;
      const next = [...attachments];
      if (!next.some((a) => a.path === hit.path)) {
        next.push({ kind: hit.kind, path: hit.path, label: hit.label });
      }
      props.onAttachmentsChange(next);
      props.onChange(props.value.replace(/@([^\s@]*)$/, "").trimEnd());
      ref.current?.focus();
    },
    [attachments, props],
  );

  const addLinkedThread = useCallback(
    (linked: LinkedThreadRef) => {
      if (!props.onLinkedThreadsChange) return;
      const next = [...linkedThreads];
      if (!next.some((l) => l.threadId === linked.threadId)) next.push(linked);
      props.onLinkedThreadsChange(next);
      props.onChange(props.value.replace(/#([^\s#]*)$/, "").trimEnd());
      ref.current?.focus();
    },
    [linkedThreads, props],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (!props.onAttachmentsChange || !props.workspaceRoot) return;
    const paths = [...e.dataTransfer.files].map((f) => (f as File & { path?: string }).path).filter(Boolean) as string[];
    if (paths.length === 0) return;
    const next = [...attachments];
    for (const path of paths) {
      if (!next.some((a) => a.path === path)) {
        next.push({ kind: "file", path, label: path.split(/[\\/]/).pop() });
      }
    }
    props.onAttachmentsChange(next);
  };

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPlusOpen(false);
        setAccessOpen(false);
        setModeOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!props.canSend && !(props.streaming && props.queuedPrompt && props.onSendNow)) return;
      // Alt+Enter while streaming: interrupt and send now.
      if (props.streaming && e.altKey && props.onSendNow) {
        props.onSendNow();
        return;
      }
      if (props.canSend) props.onSend();
    }
    // Shift+Tab rotates Agent -> Plan -> Ask (Cursor binding).
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      cycleMode();
    }
  };

  const autoGrow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const insertToken = (token: string) => {
    props.onChange(props.value.length === 0 || props.value.endsWith(" ") ? props.value + token : `${props.value} ${token}`);
    setPlusOpen(false);
    ref.current?.focus();
  };

  const queued = props.queuedPrompt?.trim() ?? "";
  const showStop = props.streaming && !!props.onStop;
  const showSend = !props.streaming || props.canSend;
  const showSendNow = props.streaming && !!props.onSendNow && (props.canSend || queued.length > 0);

  return (
    <div className="composer" ref={rootRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {(attachments.length > 0 || linkedThreads.length > 0) && (
        <div className="composer__chips">
          {attachments.map((a) => (
            <span key={a.path} className="chip chip--attach">
              <Icon name={a.kind === "folder" ? "folder" : "file"} size={12} />
              <span>{a.label ?? a.path.split(/[\\/]/).pop()}</span>
              <button
                type="button"
                className="chip__remove"
                aria-label="Remove attachment"
                onClick={() =>
                  props.onAttachmentsChange?.(attachments.filter((x) => x.path !== a.path))
                }
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
          {linkedThreads.map((l) => (
            <span key={l.threadId} className="chip chip--link">
              <Icon name="hash" size={12} />
              <span>{l.title}</span>
              <button
                type="button"
                className="chip__remove"
                aria-label="Remove linked thread"
                onClick={() =>
                  props.onLinkedThreadsChange?.(linkedThreads.filter((x) => x.threadId !== l.threadId))
                }
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      {props.compactionNotice && (
        <div className="composer__compact-warn" role="status">
          {props.compactionNotice}
        </div>
      )}
      {attachmentHeavy && (
        <div className="composer__attach-warn" role="status">
          Attachments may use ~{attachmentEstimateTokens.toLocaleString()} tokens (
          {Math.round((attachmentEstimateTokens / contextLimit) * 100)}% of context). Consider fewer or smaller
          files.
        </div>
      )}
      {queued.length > 0 && (
        <div className="composer__queue" title={queued}>
          <span className="composer__queue-label">Queued</span>
          <span className="composer__queue-text">{queued}</span>
          {props.onSendNow && (
            <button
              type="button"
              className="composer__queue-action"
              title="Stop and send now"
              onClick={() => props.onSendNow?.()}
            >
              Send now
            </button>
          )}
          {props.onClearQueue && (
            <button
              type="button"
              className="composer__queue-dismiss"
              title="Remove queued message"
              aria-label="Remove queued message"
              onClick={() => props.onClearQueue?.()}
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      )}
      {slashMatches.length > 0 && (
        <div className="slashmenu">
          {slashMatches.map((item) => (
            <button
              key={item.name}
              className="slashmenu__item"
              onClick={() => {
                props.onChange(`/${item.name} `);
                ref.current?.focus();
              }}
            >
              <code>/{item.name}</code>
              <span>{item.description}</span>
            </button>
          ))}
        </div>
      )}
      {atQuery !== null && atHits.length > 0 && (
        <div className="slashmenu">
          {atHits.map((hit) => (
            <button key={hit.path} className="slashmenu__item" onClick={() => addAttachment(hit)}>
              <Icon name={hit.kind === "folder" ? "folder" : "file"} size={14} />
              <span>{hit.label}</span>
            </button>
          ))}
        </div>
      )}
      {hashQuery !== null && hashHits.length > 0 && (
        <div className="slashmenu">
          {hashHits.map((hit) => (
            <button key={hit.threadId} className="slashmenu__item" onClick={() => addLinkedThread(hit)}>
              <Icon name="hash" size={14} />
              <span>
                {hit.title}
                {"preview" in hit && hit.preview ? (
                  <span className="slashmenu__desc">{String(hit.preview)}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          setPlusOpen(false);
          if (!props.onAttachmentsChange) return;
          const picked = [...e.target.files ?? []]
            .map((f) => (f as File & { path?: string }).path)
            .filter((p): p is string => Boolean(p));
          if (picked.length === 0) return;
          const next = [...attachments];
          for (const path of picked) {
            if (!next.some((a) => a.path === path)) {
              next.push({ kind: "file", path, label: path.split(/[\\/]/).pop() });
            }
          }
          props.onAttachmentsChange(next);
          e.target.value = "";
        }}
      />
      <textarea
        ref={ref}
        className="composer__input"
        rows={1}
        placeholder={
          props.mode === "plan"
            ? t("composer.placeholderPlan")
            : props.mode === "ask"
              ? t("composer.placeholderAsk")
              : props.mode === "delivery"
                ? t("composer.placeholderDelivery")
                : props.hasEvents
                  ? t("composer.placeholderFollowUp")
                  : t("composer.placeholder")
        }
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
          autoGrow();
        }}
        onKeyDown={handleKeyDown}
      />
      <div className="composer__row">
        <div className="menu">
          <button className="icon-btn" title="Insert" onClick={() => setPlusOpen((v) => !v)}>
            <Icon name="plus" size={15} />
          </button>
          {plusOpen && (
            <div className="menu__panel menu__panel--up">
              <button
                className="menu__item"
                onClick={() => {
                  fileInputRef.current?.click();
                  setPlusOpen(false);
                }}
              >
                <Icon name="attach" size={14} />
                Add attachment
              </button>
              <button className="menu__item" onClick={() => insertToken("@")}>
                <Icon name="at" size={14} />
                Insert @ mention
              </button>
              <button className="menu__item" onClick={() => insertToken("#")}>
                <Icon name="hash" size={14} />
                Insert # session
              </button>
              <button className="menu__item" onClick={() => insertToken("/")}>
                <Icon name="slash" size={14} />
                Insert / command
              </button>
            </div>
          )}
        </div>

        {props.mode && props.onSelectMode && (
          <div className="menu">
            <button
              className={`chip ${props.mode !== "agent" ? "chip--mode" : ""}`}
              title={t("mode.switchHint")}
              onClick={() => setModeOpen((v) => !v)}
            >
              <Icon name={MODE_META[props.mode].icon} size={13} />
              <span>{t(MODE_META[props.mode].labelKey)}</span>
              <Icon name="chevronDown" size={11} />
            </button>
            {modeOpen && (
              <div className="menu__panel menu__panel--up">
                {modeOrder.map((mode) => (
                  <button
                    key={mode}
                    className={`menu__item ${mode === props.mode ? "menu__item--active" : ""}`}
                    onClick={() => {
                      props.onSelectMode?.(mode);
                      setModeOpen(false);
                      ref.current?.focus();
                    }}
                  >
                    <Icon name={MODE_META[mode].icon} size={14} />
                    <span className="menu__item-body">
                      {t(MODE_META[mode].labelKey)}
                      <span className="menu__item-desc">{t(MODE_META[mode].descKey)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="menu">
          <button
            className={`chip ${props.approvalMode === "full-access" ? "chip--warn" : ""}`}
            onClick={() => setAccessOpen((v) => !v)}
          >
            <Icon name={APPROVAL_META[props.approvalMode].icon} size={13} />
            <span>{APPROVAL_META[props.approvalMode].label}</span>
            <Icon name="chevronDown" size={11} />
          </button>
          {accessOpen && (
            <div className="menu__panel menu__panel--up">
              {(Object.keys(APPROVAL_META) as ApprovalMode[]).map((mode) => (
                <button
                  key={mode}
                  className={`menu__item ${mode === props.approvalMode ? "menu__item--active" : ""}`}
                  onClick={() => {
                    props.onSelectApproval(mode);
                    setAccessOpen(false);
                  }}
                >
                  <Icon name={APPROVAL_META[mode].icon} size={14} />
                  {APPROVAL_META[mode].label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="composer__spacer" />

        <ContextUsage
          snapshot={props.contextSnapshot ?? null}
          contextLength={props.contextLength}
          threadKey={props.threadKey}
          attachmentEstimateTokens={attachmentEstimateTokens}
        />

        <ModelPicker
          models={props.models}
          selected={props.selectedModel}
          onSelect={props.onSelectModel}
          providers={props.providers}
          selectedProviderId={props.selectedProviderId}
          onSelectProviderModel={props.onSelectProviderModel}
          onManageModels={props.onManageModels}
        />

        <button
          className={`chip ${props.thinking ? "chip--on" : ""}`}
          title={props.thinking ? "Thinking enabled" : "Thinking disabled"}
          onClick={() => props.onToggleThinking(!props.thinking)}
        >
          <Icon name="brain" size={12} />
          <span>{props.thinking ? "On" : "Off"}</span>
        </button>

        {props.onSetGoal && (
          <button
            className={`chip ${props.goalText ? "chip--mode" : ""}`}
            title="Set a verifiable goal for this task"
            onClick={() => {
              setGoalDraft(props.goalText ?? "");
              setGoalOpen(true);
            }}
          >
            <Icon name="flag" size={12} />
            <span>{props.goalText ? "Goal" : "Set goal"}</span>
          </button>
        )}

        <div className="composer__actions">
          {showStop && (
            <button className="btn--stop" onClick={props.onStop} title="Stop the run" aria-label="Stop">
              <Icon name="close" size={14} />
            </button>
          )}
          {showSendNow && (
            <button
              className="btn--send btn--send-now"
              onClick={() => props.onSendNow?.()}
              title="Stop and send now (Alt+Enter)"
              aria-label="Stop and send now"
            >
              <Icon name="bolt" size={14} />
            </button>
          )}
          {showSend && (
            <button
              className="btn--send"
              disabled={!props.canSend}
              onClick={props.onSend}
              title={props.streaming ? "Queue message" : "Send"}
              aria-label={props.streaming ? "Queue" : "Send"}
            >
              <Icon name="arrowUp" size={15} />
            </button>
          )}
        </div>
      </div>
      {goalOpen && props.onSetGoal && (
        <div className="goal-modal-backdrop" onClick={() => setGoalOpen(false)}>
          <div
            className="goal-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Set goal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="goal-modal__title">Task goal</div>
            <p className="hint">A verifiable objective. The agent stops when it reports the goal met.</p>
            <textarea
              className="input goal-modal__input"
              rows={3}
              placeholder="e.g. All tests pass and README documents the new API"
              value={goalDraft}
              onChange={(e) => setGoalDraft(e.target.value)}
              autoFocus
            />
            <div className="goal-modal__actions">
              <button type="button" className="chip chip--small" onClick={() => setGoalOpen(false)}>
                Cancel
              </button>
              {props.goalText && (
                <button
                  type="button"
                  className="chip chip--small"
                  onClick={() => {
                    props.onSetGoal?.(null);
                    setGoalOpen(false);
                  }}
                >
                  Clear goal
                </button>
              )}
              <button
                type="button"
                className="chip chip--small chip--active"
                onClick={() => {
                  props.onSetGoal?.(goalDraft.trim() || null);
                  setGoalOpen(false);
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
