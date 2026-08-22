import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { terminalTheme, typography } from "@deyin/branding";
import { Icon } from "./Icon.js";
import type { EnvInfo, ShellInfo } from "@deyin/contract";

interface TerminalSession {
  key: string;
  label: string;
  shellId?: string;
  /** When set, attach to an existing host PTY instead of creating a new one. */
  attachId?: string;
  agent?: boolean;
}

export interface AttachableTerminal {
  id: string;
  label: string;
}

interface TerminalPanelProps {
  cwd: string | null;
  env: EnvInfo | null;
  /** Persisted default shell id (Settings → Terminal); null = host default. */
  defaultShell: string | null;
  fontSize: number;
  scrollback: number;
  cursorStyle: "bar" | "block" | "underline";
  copyOnSelect: boolean;
  /** Interface theme; the terminal palette follows it without restarting shells. */
  theme: "light" | "dark";
  /** Agent PTYs for the active thread — shown as attachable Agent tabs. */
  attachSessions?: AttachableTerminal[];
  /** When true, fills the workspace panel tab instead of bottom-docking. */
  embedded?: boolean;
  /** Workspace panel has the Terminal tab selected (pane may still be hidden during layout). */
  active?: boolean;
  /** Right panel width in px — refit when the drag handle moves the split. */
  panelWidth?: number | null;
  onClose?: () => void;
}

let sessionCounter = 0;

const HEIGHT_KEY = "deyin.terminal.height";
const MIN_HEIGHT = 120;
/** Leave the top of the window reachable even when the panel is dragged tall. */
const MAX_HEIGHT_FRACTION = 0.85;

function storedHeight(): number {
  const raw = Number(localStorage.getItem(HEIGHT_KEY));
  if (!Number.isFinite(raw) || raw < MIN_HEIGHT) return 280;
  return raw;
}

/** Portalled menu positioning — flip above/below based on viewport space. */
function useAnchoredMenu(
  open: boolean,
  anchorRef: React.RefObject<HTMLElement | null>,
  panelRef: React.RefObject<HTMLElement | null>,
) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const GAP = 6;
    const EDGE = 8;
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      const fitsBelow = anchor.bottom + GAP + panel.height <= window.innerHeight - EDGE;
      const fitsAbove = anchor.top - GAP - panel.height >= EDGE;
      setPos({
        top: fitsBelow || !fitsAbove ? anchor.bottom + GAP : anchor.top - GAP - panel.height,
        left: Math.max(EDGE, Math.min(anchor.left, window.innerWidth - EDGE - panel.width)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, panelRef]);

  return pos;
}

function useMenuDismiss(
  open: boolean,
  onClose: () => void,
  anchorRef: React.RefObject<HTMLElement | null>,
  panelRef: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open, onClose, anchorRef, panelRef]);
}

/** Bottom-docked terminal: tabbed PTY sessions with a shell picker (incl. WSL2). */
export function TerminalPanel({
  cwd,
  env,
  defaultShell,
  fontSize,
  scrollback,
  cursorStyle,
  copyOnSelect,
  theme,
  attachSessions,
  embedded = false,
  active = true,
  panelWidth,
  onClose,
}: TerminalPanelProps) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const knownAttachIdsRef = useRef<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerAnchorRef = useRef<HTMLButtonElement>(null);
  const pickerPanelRef = useRef<HTMLDivElement>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const sessionAnchorRef = useRef<HTMLButtonElement>(null);
  const sessionPanelRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const pickerPos = useAnchoredMenu(pickerOpen, pickerAnchorRef, pickerPanelRef);
  const sessionPos = useAnchoredMenu(sessionMenuOpen, sessionAnchorRef, sessionPanelRef);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const closeSessionMenu = useCallback(() => setSessionMenuOpen(false), []);
  useMenuDismiss(pickerOpen, closePicker, pickerAnchorRef, pickerPanelRef);
  useMenuDismiss(sessionMenuOpen, closeSessionMenu, sessionAnchorRef, sessionPanelRef);
  const [height, setHeight] = useState(storedHeight);
  const [maximized, setMaximized] = useState(false);
  const clearRef = useRef<Map<string, () => void>>(new Map());
  const focusRef = useRef<Map<string, () => void>>(new Map());
  const refitRef = useRef<Map<string, () => void>>(new Map());

  const addSession = useCallback(
    (shellId?: string, label?: string) => {
      sessionCounter += 1;
      const session: TerminalSession = {
        key: `term-${sessionCounter}`,
        label: label ?? shellLabel(env, shellId) ?? `Terminal ${sessionCounter}`,
        shellId,
      };
      setSessions((cur) => [...cur, session]);
      setActiveKey(session.key);
      setPickerOpen(false);
    },
    [env],
  );

  // Open the configured default shell on first mount (falls back to the host default).
  // If an agent session is already available, prefer attaching that instead.
  useEffect(() => {
    if (sessions.length === 0) {
      if (attachSessions && attachSessions.length > 0) {
        const first = attachSessions[0]!;
        sessionCounter += 1;
        const session: TerminalSession = {
          key: `term-${sessionCounter}`,
          label: first.label || "Agent",
          attachId: first.id,
          agent: true,
        };
        setSessions([session]);
        setActiveKey(session.key);
        return;
      }
      const preferred =
        defaultShell && env?.shells.some((s) => s.id === defaultShell) ? defaultShell : undefined;
      addSession(preferred, shellLabel(env, preferred ?? env?.defaultShell));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When a new agent shell is announced, add/activate an Agent tab.
  useEffect(() => {
    if (!attachSessions || attachSessions.length === 0) return;
    // Track known attach ids in a ref so the effect body (not the state updater)
    // decides what is new — keeps the updater pure under StrictMode double-invoke.
    const known = new Set(knownAttachIdsRef.current);
    const added: TerminalSession[] = [];
    for (const attach of attachSessions) {
      if (known.has(attach.id)) continue;
      sessionCounter += 1;
      added.push({
        key: `term-${sessionCounter}`,
        label: attach.label || "Agent",
        attachId: attach.id,
        agent: true,
      });
      known.add(attach.id);
    }
    knownAttachIdsRef.current = known;
    if (added.length === 0) return;
    setSessions((cur) => [...cur, ...added]);
    setActiveKey(added[added.length - 1]!.key);
  }, [attachSessions]);

  const closeSession = useCallback(
    (key: string) => {
      clearRef.current.delete(key);
      focusRef.current.delete(key);
      refitRef.current.delete(key);
      setSessions((cur) => {
        const next = cur.filter((s) => s.key !== key);
        if (next.length === 0) {
          if (embedded) {
            sessionCounter += 1;
            const preferred =
              defaultShell && env?.shells.some((s) => s.id === defaultShell) ? defaultShell : undefined;
            const session: TerminalSession = {
              key: `term-${sessionCounter}`,
              label: shellLabel(env, preferred ?? env?.defaultShell) ?? `Terminal ${sessionCounter}`,
              shellId: preferred,
            };
            setActiveKey(session.key);
            return [session];
          }
          onClose?.();
        } else if (activeKey === key) {
          setActiveKey(next[next.length - 1]!.key);
        }
        return next;
      });
    },
    [activeKey, defaultShell, embedded, env, onClose],
  );

  const refitAll = useCallback(() => {
    for (const refit of refitRef.current.values()) refit();
  }, []);

  // Refit after the workspace tab or panel width changes — hidden panes skip
  // ResizeObserver refits (0×0), so sync xterm + PTY once layout settles.
  useEffect(() => {
    if (!active) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      refitAll();
      inner = requestAnimationFrame(refitAll);
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [active, panelWidth, refitAll]);

  // Focus the active terminal on tab switch so typing lands where the eye is.
  useEffect(() => {
    if (!activeKey) return;
    const focus = focusRef.current.get(activeKey);
    if (focus) requestAnimationFrame(focus);
  }, [activeKey, sessions.length]);

  // Keep the active tab visible in the docked tab strip.
  useEffect(() => {
    if (embedded || !activeKey) return;
    tabRefs.current.get(activeKey)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeKey, embedded]);

  // Panel-level shortcuts. These never reach xterm's key handler because the
  // terminal only claims plain Ctrl combos, not the Ctrl+Shift ones used here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        const preferred =
          defaultShell && env?.shells.some((s) => s.id === defaultShell) ? defaultShell : undefined;
        addSession(preferred, shellLabel(env, preferred ?? env?.defaultShell));
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeKey) closeSession(activeKey);
        return;
      }
      // Alt+1..9 jumps straight to a tab, like every other tabbed terminal.
      if (e.altKey && !mod && /^[1-9]$/.test(e.key)) {
        const target = sessions[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          setActiveKey(target.key);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeKey, addSession, closeSession, defaultShell, env, sessions]);

  // Drag the top edge to resize.
  // cursor outruns the 6px handle, and the height is persisted per install.
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (maximized) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startHeight = height;
    const max = window.innerHeight * MAX_HEIGHT_FRACTION;
    let latest = startHeight;
    const onMove = (ev: PointerEvent) => {
      latest = Math.min(max, Math.max(MIN_HEIGHT, startHeight + (startY - ev.clientY)));
      setHeight(latest);
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing-ns");
      localStorage.setItem(HEIGHT_KEY, String(Math.round(latest)));
    };
    document.body.classList.add("is-resizing-ns");
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  const activeSession = sessions.find((s) => s.key === activeKey) ?? null;

  return (
    <div
      className={`terminal-panel ${embedded ? "terminal-panel--embedded" : ""} ${maximized ? "terminal-panel--max" : ""}`}
      style={embedded || maximized ? undefined : { height }}
    >
      {!embedded && (
        <div
          className="terminal-panel__resize"
          onPointerDown={startResize}
          onDoubleClick={() => setMaximized((v) => !v)}
          title="Drag to resize"
        />
      )}

      <div className="terminal-panel__bar">
        {embedded ? (
          <div className="terminal-panel__leading">
            <div className="terminal-panel__switch">
              <button
                ref={sessionAnchorRef}
                type="button"
                className={`termswitch${sessionMenuOpen ? " termswitch--open" : ""}`}
                title={cwd ? `${activeSession?.label ?? "Terminal"} · ${cwd}` : activeSession?.label ?? "Terminal"}
                aria-haspopup="menu"
                aria-expanded={sessionMenuOpen}
                onClick={() => {
                  setSessionMenuOpen((v) => !v);
                }}
              >
                <Icon name={activeSession?.agent ? "sparkles" : "terminal"} size={12} />
                <span className="termswitch__label">{activeSession?.label ?? "Terminal"}</span>
                {sessions.length > 1 && <span className="termswitch__count">{sessions.length}</span>}
                <Icon name="chevronDown" size={10} className="termswitch__caret" />
              </button>
              {sessionMenuOpen &&
                createPortal(
                  <div
                    ref={sessionPanelRef}
                    role="menu"
                    className="termswitch__panel termpicker termpicker--anchored"
                    style={{
                      top: sessionPos?.top ?? 0,
                      left: sessionPos?.left ?? 0,
                      visibility: sessionPos ? "visible" : "hidden",
                    }}
                  >
                    <div className="termpicker__title">Terminals</div>
                    {sessions.map((session) => {
                      const shell = env?.shells.find((s) => s.id === session.shellId);
                      return (
                        <div
                          key={session.key}
                          role="menuitem"
                          tabIndex={0}
                          className={`termpicker__item termswitch__item${session.key === activeKey ? " termswitch__item--active" : ""}`}
                          onClick={() => {
                            setActiveKey(session.key);
                            setSessionMenuOpen(false);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setActiveKey(session.key);
                              setSessionMenuOpen(false);
                            }
                          }}
                        >
                          <Icon name={session.agent ? "sparkles" : "terminal"} size={13} />
                          <span className="termpicker__name">{session.label}</span>
                          {session.agent && <span className="termpicker__tag">Agent</span>}
                          {shell?.kind === "wsl" && <span className="termpicker__tag">WSL2</span>}
                          <button
                            type="button"
                            className="termswitch__close"
                            aria-label="Close session"
                            title="Close session (Ctrl+Shift+W)"
                            onClick={(e) => {
                              e.stopPropagation();
                              closeSession(session.key);
                            }}
                          >
                            <Icon name="close" size={9} />
                          </button>
                        </div>
                      );
                    })}
                  </div>,
                  document.body,
                )}
            </div>
            <div className="terminal-panel__new">
              <button
                ref={pickerAnchorRef}
                type="button"
                className={`termbtn${pickerOpen ? " termbtn--active" : ""}`}
                title="New terminal (Ctrl+Shift+T)"
                aria-haspopup="menu"
                aria-expanded={pickerOpen}
                onClick={() => setPickerOpen((v) => !v)}
              >
                <Icon name="plus" size={13} />
              </button>
              {pickerOpen &&
                createPortal(
                  <div
                    ref={pickerPanelRef}
                    role="menu"
                    className="termpicker termpicker--anchored"
                    style={{
                      top: pickerPos?.top ?? 0,
                      left: pickerPos?.left ?? 0,
                      visibility: pickerPos ? "visible" : "hidden",
                    }}
                  >
                    <div className="termpicker__title">New terminal</div>
                    {(env?.shells ?? []).map((shell) => (
                      <button
                        key={shell.id}
                        type="button"
                        role="menuitem"
                        className="termpicker__item"
                        onClick={() => addSession(shell.id, shell.label)}
                      >
                        <Icon name="terminal" size={13} />
                        <span className="termpicker__name">{shell.label}</span>
                        {shell.id === (defaultShell ?? env?.defaultShell) && (
                          <span className="termpicker__tag">default</span>
                        )}
                        {shell.kind === "wsl" && <span className="termpicker__tag">WSL2</span>}
                      </button>
                    ))}
                    {(env?.shells ?? []).length === 0 && (
                      <div className="termpicker__item termpicker__item--empty">No shells detected</div>
                    )}
                  </div>,
                  document.body,
                )}
            </div>
          </div>
        ) : (
          <>
            <div className="terminal-panel__tabs">
              {sessions.map((session) => (
                <button
                  key={session.key}
                  ref={(el) => {
                    if (el) tabRefs.current.set(session.key, el);
                    else tabRefs.current.delete(session.key);
                  }}
                  type="button"
                  className={`termtab ${session.key === activeKey ? "termtab--active" : ""}`}
                  onClick={() => setActiveKey(session.key)}
                  onAuxClick={(e) => {
                    // Middle-click closes, matching browser and editor tab strips.
                    if (e.button === 1) {
                      e.preventDefault();
                      closeSession(session.key);
                    }
                  }}
                  title={session.label}
                >
                  <Icon name={session.agent ? "sparkles" : "terminal"} size={12} />
                  <span className="termtab__label">{session.label}</span>
                  <span
                    className="termtab__close"
                    role="button"
                    aria-label="Close session"
                    title="Close session (Ctrl+Shift+W)"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeSession(session.key);
                    }}
                  >
                    <Icon name="close" size={9} />
                  </span>
                </button>
              ))}
            </div>

            <div className="terminal-panel__new">
              <button
                ref={pickerAnchorRef}
                type="button"
                className={`termbtn${pickerOpen ? " termbtn--active" : ""}`}
                title="New terminal (Ctrl+Shift+T)"
                aria-haspopup="menu"
                aria-expanded={pickerOpen}
                onClick={() => setPickerOpen((v) => !v)}
              >
                <Icon name="plus" size={13} />
              </button>
              {pickerOpen &&
                createPortal(
                  <div
                    ref={pickerPanelRef}
                    role="menu"
                    className="termpicker termpicker--anchored"
                    style={{
                      top: pickerPos?.top ?? 0,
                      left: pickerPos?.left ?? 0,
                      visibility: pickerPos ? "visible" : "hidden",
                    }}
                  >
                    <div className="termpicker__title">New terminal</div>
                    {(env?.shells ?? []).map((shell) => (
                      <button
                        key={shell.id}
                        type="button"
                        role="menuitem"
                        className="termpicker__item"
                        onClick={() => addSession(shell.id, shell.label)}
                      >
                        <Icon name="terminal" size={13} />
                        <span className="termpicker__name">{shell.label}</span>
                        {shell.id === (defaultShell ?? env?.defaultShell) && (
                          <span className="termpicker__tag">default</span>
                        )}
                        {shell.kind === "wsl" && <span className="termpicker__tag">WSL2</span>}
                      </button>
                    ))}
                    {(env?.shells ?? []).length === 0 && (
                      <div className="termpicker__item termpicker__item--empty">No shells detected</div>
                    )}
                  </div>,
                  document.body,
                )}
            </div>
          </>
        )}

        <div className="terminal-panel__spacer" />

        {cwd && !embedded && (
          <span className="terminal-panel__cwd" title={cwd}>
            {shortPath(cwd)}
          </span>
        )}

        <button
          type="button"
          className="termbtn"
          title="Clear terminal"
          disabled={!activeSession}
          onClick={() => activeKey && clearRef.current.get(activeKey)?.()}
        >
          <Icon name="trash" size={13} />
        </button>
        {!embedded && (
          <>
            <button
              className="termbtn"
              title={maximized ? "Restore panel" : "Maximize panel"}
              onClick={() => setMaximized((v) => !v)}
            >
              <Icon name={maximized ? "minimize" : "maximize"} size={13} />
            </button>
            <button className="termbtn" title="Close terminal" onClick={onClose}>
              <Icon name="close" size={13} />
            </button>
          </>
        )}
      </div>

      <div className="terminal-panel__body">
        {sessions.map((session) => (
          <TerminalInstance
            key={session.key}
            visible={session.key === activeKey}
            paneActive={active}
            cwd={cwd}
            shellId={session.shellId}
            attachId={session.attachId}
            fontSize={fontSize}
            scrollback={scrollback}
            cursorStyle={cursorStyle}
            copyOnSelect={copyOnSelect}
            theme={theme}
            registerActions={(actions) => {
              if (actions) {
                clearRef.current.set(session.key, actions.clear);
                focusRef.current.set(session.key, actions.focus);
                refitRef.current.set(session.key, actions.refit);
              } else {
                clearRef.current.delete(session.key);
                focusRef.current.delete(session.key);
                refitRef.current.delete(session.key);
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}

function shellLabel(env: EnvInfo | null, shellId?: string): string | undefined {
  if (!env) return undefined;
  const id = shellId ?? env.defaultShell;
  return env.shells.find((s: ShellInfo) => s.id === id)?.label;
}

/** `/home/user/github/my-project` → `~/github/my-project`, tail-trimmed. */
function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

const URL_RE = /(https?:\/\/|www\.)[^\s"'`<>()[\]{}]+[^\s"'`<>()[\]{}.,;:!?]/g;

interface TerminalActions {
  clear: () => void;
  focus: () => void;
  refit: () => void;
}

function TerminalInstance({
  visible,
  paneActive,
  cwd,
  shellId,
  attachId,
  fontSize,
  scrollback,
  cursorStyle,
  copyOnSelect,
  theme,
  registerActions,
}: {
  visible: boolean;
  paneActive: boolean;
  cwd: string | null;
  shellId?: string;
  attachId?: string;
  fontSize: number;
  scrollback: number;
  cursorStyle: "bar" | "block" | "underline";
  copyOnSelect: boolean;
  theme: "light" | "dark";
  registerActions: (actions: TerminalActions | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read the newest theme/settings inside listeners without re-creating the
  // terminal — a restart would drop the shell and its scrollback.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const copyOnSelectRef = useRef(copyOnSelect);
  copyOnSelectRef.current = copyOnSelect;
  const optionsRef = useRef({ fontSize, scrollback, cursorStyle });
  optionsRef.current = { fontSize, scrollback, cursorStyle };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: typography.fontMono,
      fontSize,
      // A little air between rows; dense monospace output is the main thing
      // that made the old panel read as cramped.
      lineHeight: 1.35,
      letterSpacing: 0.2,
      scrollback,
      cursorBlink: true,
      cursorStyle: optionsRef.current.cursorStyle,
      cursorWidth: 2,
      // Programs that hard-code their own colors (some prompts, htop) can still
      // land on unreadable pairs; nudge those to a floor without flattening the
      // curated palette, which already clears this bar.
      minimumContrastRatio: 3,
      drawBoldTextInBrightColors: false,
      smoothScrollDuration: 80,
      scrollOnUserInput: true,
      rightClickSelectsWord: true,
      allowProposedApi: true,
      theme: terminalTheme(themeRef.current),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    let disposed = false;
    let termId: string | null = null;
    let pendingSize: { cols: number; rows: number } | null = null;

    const syncPtySize = (cols: number, rows: number) => {
      if (termId) window.deyin.terminal.resize(termId, cols, rows);
      else pendingSize = { cols, rows };
    };

    // Wire PTY resize before the first fit so early layout passes cannot
    // desync xterm cols/rows from the shell behind node-pty.
    term.onResize(({ cols, rows }) => syncPtySize(cols, rows));

    // Fitting while hidden (display:none) or before layout measures 0x0 cells
    // and corrupts cols/rows, so every refit path is guarded and hidden tabs
    // are refit by the visibility effect below instead.
    const safeFit = () => {
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
      try {
        fit.fit();
        if (termId) syncPtySize(term.cols, term.rows);
      } catch {
        // xterm can throw while the renderer is mid-teardown; a later refit wins.
      }
    };
    fitRef.current = safeFit;
    safeFit();

    registerActions({
      clear: () => term.clear(),
      focus: () => term.focus(),
      refit: safeFit,
    });

    // JetBrains Mono usually loads after the first synchronous fit; cell
    // metrics change with it, so refit once the font face is ready.
    let fontsCancelled = false;
    document.fonts?.ready.then(() => {
      if (!fontsCancelled) safeFit();
    });

    // Copy-on-select and Ctrl/Cmd+Shift+C/V, so the panel behaves like a real
    // terminal instead of swallowing the clipboard into the shell. The copy is
    // driven off pointerup rather than onSelectionChange, which fires on every
    // mousemove of a drag and would rewrite the clipboard dozens of times.
    const copySelection = () => {
      if (!copyOnSelectRef.current) return;
      const text = term.getSelection();
      if (text) void navigator.clipboard?.writeText(text).catch(() => {});
    };
    host.addEventListener("pointerup", copySelection);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "v") {
        void navigator.clipboard
          ?.readText()
          .then((text) => text && term.paste(text))
          .catch(() => {});
        return false;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
        const text = term.getSelection();
        if (text) void navigator.clipboard?.writeText(text).catch(() => {});
        return false;
      }
      // Let the panel's own tab shortcuts through rather than sending them to the PTY.
      if (mod && e.shiftKey && ["t", "w"].includes(e.key.toLowerCase())) return false;
      return true;
    });

    // URLs in output become clickable and open in the real browser.
    const linkSub = term.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        const line = term.buffer.active.getLine(lineNumber - 1);
        if (!line) return callback(undefined);
        const text = line.translateToString(true);
        const links = [];
        URL_RE.lastIndex = 0;
        for (const match of text.matchAll(URL_RE)) {
          const start = match.index ?? 0;
          links.push({
            text: match[0],
            range: {
              start: { x: start + 1, y: lineNumber },
              end: { x: start + match[0].length, y: lineNumber },
            },
            activate: (_event: MouseEvent, url: string) => {
              window.deyin.shell.openExternal(url.startsWith("www.") ? `https://${url}` : url);
            },
          });
        }
        callback(links.length > 0 ? links : undefined);
      },
    });

    const offData = window.deyin.terminal.onData((e) => {
      if (e.id === termId) term.write(e.data);
    });
    const offExit = window.deyin.terminal.onExit((e) => {
      // Dim + italic so the exit notice reads as chrome, not shell output.
      if (e.id === termId) term.write(`\r\n\x1b[2;3m[process exited: ${e.exitCode}]\x1b[0m\r\n`);
    });

    const bind = (id: string) => {
      if (disposed) {
        // Agent shells must not be killed when the tab unmounts mid-create.
        if (!attachId) window.deyin.terminal.kill(id);
        return;
      }
      termId = id;
      term.onData((data) => window.deyin.terminal.write(id, data));
      const size = pendingSize ?? { cols: term.cols, rows: term.rows };
      pendingSize = null;
      syncPtySize(size.cols, size.rows);
    };

    if (attachId) {
      window.deyin.terminal
        .attach(attachId)
        .then((result) => {
          if (result.scrollback) term.write(result.scrollback);
          bind(attachId);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    } else {
      window.deyin.terminal
        .create({ cwd: cwd ?? undefined, cols: term.cols, rows: term.rows, shell: shellId })
        .then(bind)
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }

    // Refit on host or flex-body size changes (panel drag, window resize),
    // debounced to one fit per frame.
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(safeFit);
    });
    observer.observe(host);
    const body = host.parentElement;
    if (body) observer.observe(body);

    return () => {
      disposed = true;
      fontsCancelled = true;
      registerActions(null);
      offData();
      offExit();
      host.removeEventListener("pointerup", copySelection);
      linkSub.dispose();
      observer.disconnect();
      cancelAnimationFrame(raf);
      // Never kill an agent shell when the tab closes — the agent still owns it.
      if (termId && !attachId) window.deyin.terminal.kill(termId);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellId, attachId]);

  // Refit when this tab or workspace pane becomes visible again (hidden tabs measure 0×0).
  useEffect(() => {
    if (!visible || !paneActive) return;
    let raf = 0;
    raf = requestAnimationFrame(() => {
      fitRef.current?.();
      raf = requestAnimationFrame(() => fitRef.current?.());
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, paneActive]);

  // Apply settings changes to live sessions without restarting the shell.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.scrollback = scrollback;
    term.options.cursorStyle = cursorStyle;
    fitRef.current?.();
  }, [fontSize, scrollback, cursorStyle]);

  // Repaint on interface-theme change; xterm swaps its palette in place.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(theme);
  }, [theme]);

  if (error) {
    return visible ? (
      <div className="terminal-host terminal-host--error">
        <Icon name="terminal" size={16} />
        <span>Terminal unavailable — {error}</span>
      </div>
    ) : null;
  }
  return <div className="terminal-host" ref={hostRef} style={{ display: visible ? "block" : "none" }} />;
}
