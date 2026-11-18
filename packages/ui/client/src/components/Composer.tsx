import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { threadPreview } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { AnchoredMenu } from "./AnchoredMenu.js";
import { ContextUsage } from "./ContextUsage.js";
import { Icon, type IconName } from "./Icon.js";
import { ModelPicker } from "./ModelPicker.js";
import { PortalledPanel } from "./PortalledPanel.js";
import { goalCommandDescription, goalComposerHint } from "../goal-command.js";
import { MODE_COMMAND_NAMES, modeCommandHint } from "../modeCommand.js";
import { clampSlashIndex, stepSlashIndex } from "../slashMenu.js";
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
/** Height cap for the auto-growing input; mirrors max-height on .composer__input. */
const MAX_INPUT_HEIGHT = 200;

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

export interface ComposerProps {
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
  hasEvents: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Abort current run and send immediately (Cursor-like interrupt). */
  onSendNow?: () => void;
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
  /** Open the full usage page (settings → Agent data) from the Context panel. */
  onOpenUsage?: () => void;
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
  /** Active goal text for this thread (goal mode). */
  goalText?: string | null;
  onSetGoal?: (text: string | null) => void;
  /** Bumped by the host to pull focus into the input (e.g. after declining a plan). */
  focusSignal?: number;
  /** Hosted web chat-only: plain messages, no agent controls. */
  plainChat?: boolean;
}

const APPROVAL_META: Record<ApprovalMode, { label: string; icon: "shield" | "hand" | "eye" }> = {
  "full-access": { label: "Full access", icon: "shield" },
  "ask-first": { label: "Ask before changes", icon: "hand" },
  "read-only": { label: "Read only", icon: "eye" },
};

const MODE_ORDER: ChatMode[] = ["agent", "delivery", "plan", "ask", "bot"];

/** Read-out labels for the non-default mode chip (modes are selected by typing). */
const MODE_LABEL: Record<ChatMode, string> = {
  agent: "Agent",
  delivery: "Delivery",
  plan: "Plan",
  ask: "Ask",
  bot: "Bot Mode",
};

const MODE_ICON: Record<ChatMode, IconName> = {
  agent: "bolt",
  delivery: "shield",
  plan: "route",
  ask: "message",
  bot: "bot",
};

/** `/mode` command descriptions for the slash menu, one per selectable mode. */
const MODE_COMMAND_DESC: Record<string, string> = {
  agent: "Build mode: full tool access",
  plan: "Plan mode: research read-only, then propose a plan",
  ask: "Ask mode: answer questions, change nothing",
  bot: "Bot mode: orchestrate external tools across pipelines",
};

interface SlashItem {
  name: string;
  description: string;
}

/** Compact elapsed time for the live run strip: 8s, 1m 12s, 1h 4m. */
function formatRunTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const seconds = total % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function Composer(props: ComposerProps) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
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
  const [slashItems, setSlashItems] = useState<SlashItem[]>([]);
  /** Highlighted row in the slash menu (Up/Down move it; Enter/Tab accept it). */
  const [slashIndex, setSlashIndex] = useState(0);
  /** Text the slash menu was dismissed for with Esc; it stays shut until the text changes. */
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null);
  const activeSlashRef = useRef<HTMLButtonElement | null>(null);
  /** The composer holds a bare "/name" prefix, so the command menu is in play. */
  const slashOpen =
    props.value.startsWith("/") && !props.value.includes("\n") && !props.value.includes(" ");
  const [atHits, setAtHits] = useState<ContextSearchHit[]>([]);
  const [hashHits, setHashHits] = useState<LinkedThreadRef[]>([]);
  const [goalOpen, setGoalOpen] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  const openGoalDialog = () => {
    setGoalDraft(props.goalText ?? "");
    setGoalOpen(true);
  };
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
    setPlusOpen(false);
    setAccessOpen(false);
    const next = modeOrder[(modeOrder.indexOf(props.mode!) + 1) % modeOrder.length]!;
    props.onSelectMode(next);
  };

  const closeComposerMenus = useCallback(() => {
    setPlusOpen(false);
    setAccessOpen(false);
  }, []);

  // Ctrl/Cmd+. focuses the composer on a "/" prefix, the mode menu's keyboard
  // slot now that modes are typed rather than picked from a dropdown.
  useEffect(() => {
    if (!props.mode) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ".") {
        e.preventDefault();
        setPlusOpen(false);
        setAccessOpen(false);
        if (!props.value.startsWith("/")) props.onChange("/");
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.mode, props.value, props.onChange]);

  useEffect(() => {
    if (!goalOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setGoalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goalOpen]);

  // Slash autocomplete sources: commands plus skills (invocable as /skill-name).
  // Re-scanned when the workspace changes and whenever the menu opens: commands
  // and skills are workspace-scoped, and one authored mid-session (create-skill)
  // has to show up without restarting the app. The host caches the scan, so
  // reopening the menu is cheap.
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
        // Client-side commands handled in App.send, not by the host.
        for (const name of MODE_COMMAND_NAMES) {
          if (!byName.has(name)) {
            byName.set(name, { name, description: MODE_COMMAND_DESC[name] ?? "" });
          }
        }
        if (!byName.has("goal")) {
          byName.set("goal", { name: "goal", description: "Set the task goal; no text clears it" });
        }
        setSlashItems([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [slashOpen, props.workspaceRoot]);

  const slashMatches = (() => {
    if (!slashOpen) return [];
    const query = props.value.slice(1).toLowerCase();
    return slashItems.filter((i) => i.name.startsWith(query)).slice(0, 8);
  })();
  const showSlashMenu = slashMatches.length > 0 && slashDismissedFor !== props.value;
  const activeSlashIndex = clampSlashIndex(slashIndex, slashMatches.length);

  // A new query starts at the best match again.
  const slashQuery = slashOpen ? props.value.slice(1) : null;
  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);
  useEffect(() => {
    if (showSlashMenu) activeSlashRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [showSlashMenu, activeSlashIndex]);

  /** Put "/name " in the box (the space closes the menu) so arguments can follow. */
  const acceptSlash = (item: SlashItem) => {
    props.onChange(`/${item.name} `);
    setSlashDismissedFor(null);
    ref.current?.focus();
  };

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

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The command menu owns the keyboard while it is open: Enter or Tab complete
    // the highlighted command instead of sending "/goal" as a message.
    if (showSlashMenu) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex(stepSlashIndex(activeSlashIndex, e.key === "ArrowDown" ? 1 : -1, slashMatches.length));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const item = slashMatches[activeSlashIndex];
        if (item) acceptSlash(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissedFor(props.value);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!props.canSend && !(props.streaming && props.onSendNow)) return;
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

  const autoGrow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, []);

  // Keep the textarea height in sync with its content on every value change,
  // typed or programmatic: send clears the draft, a thread switch restores
  // one, token/attachment insertion rewrites it. Resizing only on keystrokes
  // left a stale inline height behind, so the composer stayed expanded after
  // sending a long message or collapsed at the wrong size on thread switches.
  // Layout effect so the height settles before paint (no flicker on restore).
  useLayoutEffect(() => {
    autoGrow();
  }, [props.value, autoGrow]);

  const insertToken = (token: string) => {
    props.onChange(props.value.length === 0 || props.value.endsWith(" ") ? props.value + token : `${props.value} ${token}`);
    setPlusOpen(false);
    ref.current?.focus();
  };

   const showStop = props.streaming && !!props.onStop;
  const showSend = !props.streaming || props.canSend;
  const goalHint = props.plainChat ? null : goalComposerHint(props.value, props.goalText);
  const modeHint = props.plainChat || !props.mode ? null : modeCommandHint(props.value);
  const showAtMenu = atQuery !== null && atHits.length > 0;
  const showHashMenu = hashQuery !== null && hashHits.length > 0;

  useEffect(() => {
    if (showSlashMenu || showAtMenu || showHashMenu) closeComposerMenus();
  }, [showSlashMenu, showAtMenu, showHashMenu, closeComposerMenus]);

  return (
    <div className="composer" ref={composerRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
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
      {/* Live run status: what the agent is doing right now, in one line. */}
      {props.runStatus && props.streaming && (
        <div className="composer__run-status" role="status" aria-live="polite">
          <span className={`composer__run-dot composer__run-dot--${props.runStatus.phase}`} />
          <span className="composer__run-label">{props.runStatus.label}</span>
          {props.runStatus.workDurationMs > 0 && (
            <span className="composer__run-time">{formatRunTime(props.runStatus.workDurationMs)}</span>
          )}
          {props.runStatus.retryCount > 0 && (
            <span className="composer__run-retry">
              retry {props.runStatus.retryCount}/{props.runStatus.maxRetries}
            </span>
          )}
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
      {showSlashMenu && (
        <PortalledPanel
          open
          onClose={() => undefined}
          anchorRef={composerRef}
          matchAnchorWidth
          gap={6}
          className="slashmenu slashmenu--portalled"
        >
          {slashMatches.map((item, i) => (
            <button
              key={item.name}
              ref={i === activeSlashIndex ? activeSlashRef : undefined}
              type="button"
              role="option"
              aria-selected={i === activeSlashIndex}
              className={`slashmenu__item${i === activeSlashIndex ? " slashmenu__item--active" : ""}`}
              onMouseEnter={() => setSlashIndex(i)}
              onClick={() => acceptSlash(item)}
            >
              <code>/{item.name}</code>
              <span>{item.name === "goal" ? goalCommandDescription(props.goalText) : item.description}</span>
            </button>
          ))}
        </PortalledPanel>
      )}
      {showAtMenu && (
        <PortalledPanel
          open
          onClose={() => undefined}
          anchorRef={composerRef}
          matchAnchorWidth
          gap={6}
          className="slashmenu slashmenu--portalled"
        >
          {atHits.map((hit) => (
            <button key={hit.path} type="button" className="slashmenu__item" onClick={() => addAttachment(hit)}>
              <Icon name={hit.kind === "folder" ? "folder" : "file"} size={14} />
              <span>{hit.label}</span>
            </button>
          ))}
        </PortalledPanel>
      )}
      {showHashMenu && (
        <PortalledPanel
          open
          onClose={() => undefined}
          anchorRef={composerRef}
          matchAnchorWidth
          gap={6}
          className="slashmenu slashmenu--portalled"
        >
          {hashHits.map((hit) => (
            <button key={hit.threadId} type="button" className="slashmenu__item" onClick={() => addLinkedThread(hit)}>
              <Icon name="hash" size={14} />
              <span>
                {hit.title}
                {"preview" in hit && hit.preview ? (
                  <span className="slashmenu__desc">{String(hit.preview)}</span>
                ) : null}
              </span>
            </button>
          ))}
        </PortalledPanel>
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
          props.plainChat
            ? t("composer.placeholderPlainChat")
            : props.mode === "plan"
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
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
      />
      {goalHint && <div className="composer__hint">{goalHint}</div>}
      {!goalHint && modeHint && <div className="composer__hint">{modeHint}</div>}
      <div className="composer__row">
        {!props.plainChat ? (
        <AnchoredMenu
          open={plusOpen}
          onToggle={() => {
            setAccessOpen(false);
            setPlusOpen((v) => !v);
          }}
          onClose={() => setPlusOpen(false)}
          triggerClassName="icon-btn"
          triggerTitle="Insert"
          trigger={<Icon name="plus" size={15} />}
        >
          <button
            type="button"
            className="menu__item"
            onClick={() => {
              fileInputRef.current?.click();
              setPlusOpen(false);
            }}
          >
            <Icon name="attach" size={14} />
            Add attachment
          </button>
          <button type="button" className="menu__item" onClick={() => insertToken("@")}>
            <Icon name="at" size={14} />
            Insert @ mention
          </button>
          <button type="button" className="menu__item" onClick={() => insertToken("#")}>
            <Icon name="hash" size={14} />
            Insert # session
          </button>
          <button type="button" className="menu__item" onClick={() => insertToken("/")}>
            <Icon name="slash" size={14} />
            Insert / command
          </button>
          {props.mode && props.onSelectMode && (
            <button
              type="button"
              className="menu__item"
              onClick={() => {
                setPlusOpen(false);
                // Type the mode rather than opening a second menu: the slash menu
                // then lists every mode (and its description) in one place.
                props.onChange("/plan ");
                ref.current?.focus();
              }}
            >
              <Icon name="route" size={14} />
              Switch mode (/plan, /ask, /bot)
            </button>
          )}
          {props.onSetGoal && (
            <button
              type="button"
              className="menu__item"
              onClick={() => {
                setPlusOpen(false);
                // No goal yet: start a /goal command so the objective is typed in the
                // box (and restated by the agent). An existing goal is edited verbatim.
                if (props.goalText) {
                  openGoalDialog();
                } else {
                  props.onChange("/goal ");
                  ref.current?.focus();
                }
              }}
            >
              <Icon name="flag" size={14} />
              {props.goalText ? "Edit goal" : "Set goal"}
            </button>
          )}
        </AnchoredMenu>
        ) : null}

        {/* Mode is chosen by typing (/plan, /ask, /bot, /agent), so this row holds
            no mode menu. A chip appears only while the thread is outside the
            default build mode, as the way back out. */}
        {!props.plainChat && props.mode && props.mode !== "agent" && (
          <button
            type="button"
            className="chip chip--mode"
            title={`${MODE_LABEL[props.mode]} mode. Click to return to Agent mode, or type /agent.`}
            onClick={() => {
              props.onSelectMode?.("agent");
              ref.current?.focus();
            }}
          >
            <Icon name={MODE_ICON[props.mode]} size={13} />
            <span>{MODE_LABEL[props.mode]}</span>
            <Icon name="close" size={11} />
          </button>
        )}

        {!props.plainChat ? (
        <AnchoredMenu
          open={accessOpen}
          onToggle={() => {
            setPlusOpen(false);
            setAccessOpen((v) => !v);
          }}
          onClose={() => setAccessOpen(false)}
          triggerClassName={`chip ${props.approvalMode === "full-access" ? "chip--warn" : ""}`}
          trigger={
            <>
              <Icon name={APPROVAL_META[props.approvalMode].icon} size={13} />
              <span>{APPROVAL_META[props.approvalMode].label}</span>
              <Icon name="chevronDown" size={11} />
            </>
          }
        >
          {(Object.keys(APPROVAL_META) as ApprovalMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
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
        </AnchoredMenu>
        ) : null}

        {!props.plainChat && props.onSetGoal && props.goalText && (
          <button
            type="button"
            className="chip chip--mode"
            title={`Goal: ${props.goalText}`}
            onClick={openGoalDialog}
          >
            <Icon name="flag" size={12} />
            <span>Goal</span>
          </button>
        )}

        <div className="composer__spacer" />

        <ContextUsage
          snapshot={props.contextSnapshot ?? null}
          contextLength={props.contextLength}
          threadKey={props.threadKey}
          attachmentEstimateTokens={attachmentEstimateTokens}
          onOpenUsage={props.onOpenUsage}
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
          thinking={props.thinking}
          onToggleThinking={props.onToggleThinking}
        />

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
            <p className="hint">A verifiable objective. The agent can report when it is met via report_goal_met.</p>
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
