import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { colors } from "@deyin/branding";
import { Icon } from "./Icon.js";
import type { EnvInfo } from "../../shared/types.js";

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
  /** Agent PTYs for the active thread — shown as attachable Agent tabs. */
  attachSessions?: AttachableTerminal[];
  onClose: () => void;
}

let sessionCounter = 0;

/** Bottom-docked terminal: tabbed PTY sessions with a shell picker (incl. WSL2). */
export function TerminalPanel({
  cwd,
  env,
  defaultShell,
  fontSize,
  scrollback,
  attachSessions,
  onClose,
}: TerminalPanelProps) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const addSession = (shellId?: string, label?: string) => {
    sessionCounter += 1;
    const session: TerminalSession = {
      key: `term-${sessionCounter}`,
      label: label ?? shellLabel(env, shellId) ?? `Terminal ${sessionCounter}`,
      shellId,
    };
    setSessions((cur) => [...cur, session]);
    setActiveKey(session.key);
    setPickerOpen(false);
  };

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
    setSessions((cur) => {
      let next = cur;
      let changed = false;
      for (const attach of attachSessions) {
        if (next.some((s) => s.attachId === attach.id)) continue;
        sessionCounter += 1;
        const session: TerminalSession = {
          key: `term-${sessionCounter}`,
          label: attach.label || "Agent",
          attachId: attach.id,
          agent: true,
        };
        next = changed ? [...next, session] : [...cur, session];
        changed = true;
        setActiveKey(session.key);
      }
      return changed ? next : cur;
    });
  }, [attachSessions]);

  const closeSession = (key: string) => {
    setSessions((cur) => {
      const next = cur.filter((s) => s.key !== key);
      if (next.length === 0) onClose();
      else if (activeKey === key) setActiveKey(next[next.length - 1]!.key);
      return next;
    });
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__bar">
        <Icon name="terminal" size={13} />
        {sessions.map((session) => (
          <span
            key={session.key}
            className={`termtab ${session.key === activeKey ? "termtab--active" : ""}`}
            onClick={() => setActiveKey(session.key)}
          >
            {session.label}
            {session.agent && <span className="badge badge--quota">Agent</span>}
            <button
              className="termtab__close"
              title="Close session"
              onClick={(e) => {
                e.stopPropagation();
                closeSession(session.key);
              }}
            >
              <Icon name="close" size={10} />
            </button>
          </span>
        ))}

        <div className="menu">
          <button className="icon-btn icon-btn--small" title="New terminal" onClick={() => setPickerOpen((v) => !v)}>
            <Icon name="plus" size={13} />
          </button>
          {pickerOpen && (
            <div className="menu__panel menu__panel--up termpicker">
              {(env?.shells ?? []).map((shell) => (
                <button key={shell.id} className="menu__item" onClick={() => addSession(shell.id, shell.label)}>
                  <Icon name="terminal" size={13} />
                  {shell.label}
                  {shell.kind === "wsl" && <span className="badge badge--quota">WSL2</span>}
                </button>
              ))}
              {(env?.shells ?? []).length === 0 && <div className="menu__item hint">No shells detected</div>}
            </div>
          )}
        </div>

        <div className="terminal-panel__spacer" />
        <button className="icon-btn icon-btn--small" title="Close terminal" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="terminal-panel__body">
        {sessions.map((session) => (
          <TerminalInstance
            key={session.key}
            visible={session.key === activeKey}
            cwd={cwd}
            shellId={session.shellId}
            attachId={session.attachId}
            fontSize={fontSize}
            scrollback={scrollback}
          />
        ))}
      </div>
    </div>
  );
}

function shellLabel(env: EnvInfo | null, shellId?: string): string | undefined {
  if (!env) return undefined;
  const id = shellId ?? env.defaultShell;
  return env.shells.find((s) => s.id === id)?.label;
}

function TerminalInstance({
  visible,
  cwd,
  shellId,
  attachId,
  fontSize,
  scrollback,
}: {
  visible: boolean;
  cwd: string | null;
  shellId?: string;
  attachId?: string;
  fontSize: number;
  scrollback: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize,
      scrollback,
      cursorBlink: true,
      theme: { background: "#05070a", foreground: colors.text, cursor: colors.accent },
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    // Fitting while hidden (display:none) or before layout measures 0x0 cells
    // and corrupts cols/rows, so every refit path is guarded and hidden tabs
    // are refit by the visibility effect below instead.
    const safeFit = () => {
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // xterm can throw while the renderer is mid-teardown; a later refit wins.
      }
    };
    fitRef.current = safeFit;
    safeFit();

    // JetBrains Mono usually loads after the first synchronous fit; cell
    // metrics change with it, so refit once the font face is ready.
    let fontsCancelled = false;
    document.fonts?.ready.then(() => {
      if (!fontsCancelled) safeFit();
    });

    let disposed = false;
    let termId: string | null = null;
    const offData = window.deyin.terminal.onData((e) => {
      if (e.id === termId) term.write(e.data);
    });
    const offExit = window.deyin.terminal.onExit((e) => {
      if (e.id === termId) term.write(`\r\n[process exited: ${e.exitCode}]\r\n`);
    });

    const bind = (id: string) => {
      if (disposed) {
        // Agent shells must not be killed when the tab unmounts mid-create.
        if (!attachId) window.deyin.terminal.kill(id);
        return;
      }
      termId = id;
      term.onData((data) => window.deyin.terminal.write(id, data));
      term.onResize(({ cols, rows }) => window.deyin.terminal.resize(id, cols, rows));
      window.deyin.terminal.resize(id, term.cols, term.rows);
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

    // Refit on any host-size change (window resize, side panel toggling,
    // layout shifts), debounced to one fit per frame.
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(safeFit);
    });
    observer.observe(host);

    return () => {
      disposed = true;
      fontsCancelled = true;
      offData();
      offExit();
      observer.disconnect();
      cancelAnimationFrame(raf);
      // Never kill an agent shell when the tab closes — the agent still owns it.
      if (termId && !attachId) window.deyin.terminal.kill(termId);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellId, attachId]);

  // Refit when this tab becomes visible again (hidden tabs measure 0x0).
  useEffect(() => {
    if (visible) fitRef.current?.();
  }, [visible]);

  // Apply settings changes to live sessions without restarting the shell.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.scrollback = scrollback;
    fitRef.current?.();
  }, [fontSize, scrollback]);

  if (error) {
    return visible ? <div className="terminal-host hint">Terminal unavailable: {error}</div> : null;
  }
  return <div className="terminal-host" ref={hostRef} style={{ display: visible ? "block" : "none" }} />;
}
