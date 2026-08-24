import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
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
} from "@deyin/contract";
import type { ModelReasoningMode } from "@deyin/host-core/shared";

/** An image attached to the next message, read as base64 (works on web + desktop). */
export interface ComposerImage {
  id: string;
  name: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  base64: string;
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Read an image file into a ComposerImage (base64, no data: prefix). */
function readImageFile(file: File): Promise<ComposerImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const comma = dataUrl.indexOf(",");
      const header = comma >= 0 ? dataUrl.slice(0, comma) : "";
      const mediaType = (header.match(/^data:([^;]+)/)?.[1] ?? file.type) as ComposerImage["mediaType"];
      resolve({
        id: `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: file.name,
        mediaType,
        base64: dataUrl.slice(comma + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

interface ComposerProps {
  value: string;
  models: ModelInfo[];
  selectedModel: string;
  approvalMode: ApprovalMode;
  /** Composer mode (Agent/Plan/Ask); hidden when undefined (e.g. web plain chat). */
  mode?: ChatMode;
  /** When false, Delivery mode is hidden from the mode switcher. */
  deliveryModeEnabled?: boolean;
  /** Global thinking default when the selected model has no explicit mode. */
  thinking?: boolean;
  thinkingDefault?: boolean;
  modelEfforts?: Record<string, string>;
  onSetModelEffort?: (providerId: string, modelId: string, mode: ModelReasoningMode | undefined) => void;
  onToggleThinking?: (on: boolean) => void;
  canSend: boolean;
  streaming: boolean;
  /** Follow-up queued while a run is active. */
  queuedPrompt?: string | null;
  hasEvents: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Abort current run and send immediately (Cursor-like interrupt). */
  onSendNow?: () => void;
  /** Queue draft as follow-up without stopping the run (Cursor Steer). */
  onSteer?: () => void;
  onClearQueue?: () => void;
  /** When set and streaming, a stop button is shown. */
  onStop?: () => void;
  onSelectModel: (id: string) => void;
  onSelectApproval: (mode: ApprovalMode) => void;
  onSelectMode?: (mode: ChatMode) => void;
  onManageModels?: () => void;
  providers?: import("@deyin/contract").ProviderInfo[];
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
  /** Images attached to the next message (vision); base64, platform-independent. */
  images?: ComposerImage[];
  onImagesChange?: (next: ComposerImage[]) => void;
  linkedThreads?: LinkedThreadRef[];
  onLinkedThreadsChange?: (next: LinkedThreadRef[]) => void;
  /** Other threads in the project for # linking. */
  threadsForPicker?: Thread[];
  activeThreadId?: string | null;
  workspaceRoot?: string | null;
  /** Bumped by the host to pull focus into the input (e.g. after declining a plan). */
  focusSignal?: number;
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
  const focusSignal = props.focusSignal ?? 0;
  useEffect(() => {
    if (focusSignal > 0) ref.current?.focus();
  }, [focusSignal]);
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
        // Client-side command handled in App.send, not by the host.
        if (!byName.has("goal")) {
          byName.set("goal", { name: "goal", description: "Set the task goal; no text clears it" });
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

  const images = props.images ?? [];
  const [imageError, setImageError] = useState<string | null>(null);

  /** Attach image files (picker, drag-drop or paste) as base64 vision inputs. */
  const addImageFiles = useCallback(
    (files: File[]) => {
      if (!props.onImagesChange) return;
      setImageError(null);
      const picked = files.filter((f) => f.type.startsWith("image/"));
      if (picked.length === 0) return;
      if (images.length + picked.length > MAX_IMAGES) {
        setImageError(`At most ${MAX_IMAGES} images per message.`);
        return;
      }
      const oversized = picked.find((f) => f.size > MAX_IMAGE_BYTES);
      if (oversized) {
        setImageError(`${oversized.name} is larger than 5 MB.`);
        return;
      }
      void Promise.all(picked.map(readImageFile))
        .then((loaded) => {
          props.onImagesChange!([...images, ...loaded]);
          ref.current?.focus();
        })
        .catch((err) => setImageError(err instanceof Error ? err.message : String(err)));
    },
    [images, props],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const dropped = [...e.dataTransfer.files];
    // Images become vision attachments on every platform (base64 read).
    const imageFiles = dropped.filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length > 0 && props.onImagesChange) {
      addImageFiles(imageFiles);
      return;
    }
    if (!props.onAttachmentsChange || !props.workspaceRoot) return;
    const paths = dropped.map((f) => (f as File & { path?: string }).path).filter(Boolean) as string[];
    if (paths.length === 0) return;
    const next = [...attachments];
    for (const path of paths) {
      if (!next.some((a) => a.path === path)) {
        next.push({ kind: "file", path, label: path.split(/[\\/]/).pop() });
      }
    }
    props.onAttachmentsChange(next);
  };

  // Paste screenshots straight into the composer (vision input).
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (pasted.some((f) => f.type.startsWith("image/")) && props.onImagesChange) {
      e.preventDefault();
      addImageFiles(pasted);
    }
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
  const draft = props.value.trim();
  const showSteerBar = props.streaming && draft.length > 0 && queued.length === 0;
  const showStop = props.streaming && !!props.onStop;
  const showSend = !props.streaming || props.canSend;

  return (
    <div className="composer" ref={rootRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {queued.length > 0 && (
        <div className="composer__pending composer__pending--queued" title={queued}>
          <span className="composer__pending-label">Queued</span>
          <span className="composer__pending-text">{queued}</span>
          <div className="composer__pending-actions">
            {props.onSendNow && (
              <button
                type="button"
                className="composer__pending-link"
                title="Stop and send now"
                onClick={() => props.onSendNow?.()}
              >
                Send now
              </button>
            )}
            {props.onClearQueue && (
              <button
                type="button"
                className="composer__pending-dismiss"
                title="Remove queued message"
                aria-label="Remove queued message"
                onClick={() => props.onClearQueue?.()}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        </div>
      )}
      {showSteerBar && (
        <div className="composer__pending composer__pending--steer" title={draft}>
          <Icon name="steer" size={14} className="composer__pending-steer-icon" />
          <span className="composer__pending-text composer__pending-text--quoted">&ldquo;{draft}&rdquo;</span>
          <div className="composer__pending-actions">
            <button
              type="button"
              className="composer__pending-steer"
              title="Queue as follow-up without stopping the run"
              onClick={() => (props.onSteer ?? props.onSend)()}
            >
              <Icon name="steer" size={12} />
              Steer
            </button>
            <button
              type="button"
              className="composer__pending-dismiss"
              title="Discard draft"
              aria-label="Discard draft"
              onClick={() => props.onChange("")}
            >
              <Icon name="trash" size={12} />
            </button>
            <button
              type="button"
              className="composer__pending-dismiss"
              title="More options"
              aria-label="More options"
              disabled
            >
              <Icon name="dots" size={12} />
            </button>
          </div>
        </div>
      )}
      {(attachments.length > 0 || linkedThreads.length > 0 || images.length > 0) && (
        <div className="composer__chips">
          {images.map((img) => (
            <span key={img.id} className="chip chip--attach chip--image" title={img.name}>
              <img className="chip__thumb" src={`data:${img.mediaType};base64,${img.base64}`} alt={img.name} />
              <span>{img.name}</span>
              <button
                type="button"
                className="chip__remove"
                aria-label="Remove image"
                onClick={() => props.onImagesChange?.(images.filter((x) => x.id !== img.id))}
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
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
      {imageError && (
        <div className="composer__attach-warn" role="status">
          {imageError}
        </div>
      )}
      {attachmentHeavy && (
        <div className="composer__attach-warn" role="status">
          Attachments may use ~{attachmentEstimateTokens.toLocaleString()} tokens (
          {Math.round((attachmentEstimateTokens / contextLimit) * 100)}% of context). Consider fewer or smaller
          files.
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
          const picked = [...e.target.files ?? []];
          e.target.value = "";
          // Images become base64 vision attachments on every platform.
          const imageFiles = picked.filter((f) => f.type.startsWith("image/"));
          if (imageFiles.length > 0 && props.onImagesChange) addImageFiles(imageFiles);
          if (!props.onAttachmentsChange) return;
          const paths = picked.map((f) => (f as File & { path?: string }).path).filter((p): p is string => Boolean(p));
          if (paths.length === 0) return;
          const next = [...attachments];
          for (const path of paths) {
            if (!next.some((a) => a.path === path)) {
              next.push({ kind: "file", path, label: path.split(/[\\/]/).pop() });
            }
          }
          props.onAttachmentsChange(next);
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
        onPaste={onPaste}
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
          modelEfforts={props.modelEfforts}
          thinkingDefault={props.thinkingDefault}
          onSetModelEffort={props.onSetModelEffort}
        />

        {props.onToggleThinking && (
          <button
            className={`chip ${(props.thinking ?? props.thinkingDefault ?? true) ? "chip--on" : ""}`}
            title={(props.thinking ?? props.thinkingDefault ?? true) ? "Thinking enabled" : "Thinking disabled"}
            onClick={() => props.onToggleThinking?.(!(props.thinking ?? props.thinkingDefault ?? true))}
          >
            <Icon name="brain" size={12} />
            <span>{(props.thinking ?? props.thinkingDefault ?? true) ? "On" : "Off"}</span>
          </button>
        )}

        <div className="composer__actions">
          {showStop && (
            <button className="btn--stop" onClick={props.onStop} title="Stop the run" aria-label="Stop">
              <Icon name="close" size={14} />
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
