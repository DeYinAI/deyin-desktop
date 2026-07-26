import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./Icon.js";
import { ModelPicker } from "./ModelPicker.js";
import type { ApprovalMode, ModelInfo } from "../../shared/types.js";

interface ComposerProps {
  value: string;
  models: ModelInfo[];
  selectedModel: string;
  approvalMode: ApprovalMode;
  thinking: boolean;
  canSend: boolean;
  streaming: boolean;
  hasEvents: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onSelectModel: (id: string) => void;
  onSelectApproval: (mode: ApprovalMode) => void;
  onToggleThinking: (on: boolean) => void;
  onManageModels?: () => void;
  providers?: import("../../shared/types.js").ProviderInfo[];
  selectedProviderId?: string;
  onSelectProviderModel?: (providerId: string, modelId: string) => void;
}

const APPROVAL_META: Record<ApprovalMode, { label: string; icon: "shield" | "hand" | "eye" }> = {
  "full-access": { label: "Full access", icon: "shield" },
  "ask-first": { label: "Ask before changes", icon: "hand" },
  "read-only": { label: "Read only", icon: "eye" },
};

export function Composer(props: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
      if (props.canSend) props.onSend();
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

  return (
    <div className="composer" ref={rootRef}>
      <textarea
        ref={ref}
        className="composer__input"
        rows={1}
        placeholder={props.hasEvents ? "Ask for follow-up changes" : "Ask Deyin anything, @ for files, / for commands, $ for skills, # for chats"}
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

        <button
          className="btn--send"
          disabled={!props.canSend}
          onClick={props.onSend}
          title={props.streaming ? "Streaming..." : "Send"}
          aria-label="Send"
        >
          <Icon name="arrowUp" size={15} />
        </button>
      </div>
    </div>
  );
}
