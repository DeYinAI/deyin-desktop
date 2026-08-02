import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "../i18n.js";
import { ContextUsage } from "./ContextUsage.js";
import { Icon, type IconName } from "./Icon.js";
import { ModelPicker } from "./ModelPicker.js";
import type { ApprovalMode, ChatMode, ContextUsageSnapshot, ModelInfo } from "../../shared/types.js";

interface ComposerProps {
  value: string;
  models: ModelInfo[];
  selectedModel: string;
  approvalMode: ApprovalMode;
  /** Composer mode (Agent/Plan/Ask); hidden when undefined (e.g. web plain chat). */
  mode?: ChatMode;
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
}

const APPROVAL_META: Record<ApprovalMode, { label: string; icon: "shield" | "hand" | "eye" }> = {
  "full-access": { label: "Full access", icon: "shield" },
  "ask-first": { label: "Ask before changes", icon: "hand" },
  "read-only": { label: "Read only", icon: "eye" },
};

const MODE_ORDER: ChatMode[] = ["agent", "plan", "ask"];
const MODE_META: Record<ChatMode, { labelKey: "mode.agent" | "mode.plan" | "mode.ask"; descKey: "mode.agentDesc" | "mode.planDesc" | "mode.askDesc"; icon: IconName }> = {
  agent: { labelKey: "mode.agent", descKey: "mode.agentDesc", icon: "bolt" },
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
  const [plusOpen, setPlusOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [slashItems, setSlashItems] = useState<SlashItem[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  const cycleMode = () => {
    if (!props.mode || !props.onSelectMode) return;
    const next = MODE_ORDER[(MODE_ORDER.indexOf(props.mode) + 1) % MODE_ORDER.length]!;
    props.onSelectMode(next);
  };

  // Ctrl/Cmd+. cycles the composer mode (Cursor's Mode Menu binding, no popup).
  useEffect(() => {
    if (!props.mode) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ".") {
        e.preventDefault();
        cycleMode();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.mode]);

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

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPlusOpen(false);
        setAccessOpen(false);
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
    <div className="composer" ref={rootRef}>
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
      <textarea
        ref={ref}
        className="composer__input"
        rows={1}
        placeholder={
          props.mode === "plan"
            ? t("composer.placeholderPlan")
            : props.mode === "ask"
              ? t("composer.placeholderAsk")
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
              <button className="menu__item" onClick={() => setPlusOpen(false)}>
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
          <div className="mode-seg" role="tablist" aria-label={t("mode.switchHint")}>
            {MODE_ORDER.map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={mode === props.mode}
                title={t(MODE_META[mode].descKey)}
                className={`mode-seg__item ${mode === props.mode ? "mode-seg__item--active" : ""}`}
                onClick={() => {
                  props.onSelectMode?.(mode);
                  ref.current?.focus();
                }}
              >
                <Icon name={MODE_META[mode].icon} size={12} />
                <span>{t(MODE_META[mode].labelKey)}</span>
              </button>
            ))}
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
    </div>
  );
}
