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
}

interface TerminalPanelProps {
  cwd: string | null;
  env: EnvInfo | null;
  onClose: () => void;
}

let sessionCounter = 0;

/** Bottom-docked terminal: tabbed PTY sessions with a shell picker (incl. WSL2). */
export function TerminalPanel({ cwd, env, onClose }: TerminalPanelProps) {
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

  // Open the default shell on first mount.
  useEffect(() => {
    if (sessions.length === 0) addSession(undefined, shellLabel(env, env?.defaultShell));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            <div className="menu__panel">
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
          <TerminalInstance key={session.key} visible={session.key === activeKey} cwd={cwd} shellId={session.shellId} />
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

function TerminalInstance({ visible, cwd, shellId }: { visible: boolean; cwd: string | null; shellId?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: { background: "#05070a", foreground: colors.text, cursor: colors.accent },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let disposed = false;
    let termId: string | null = null;
    const offData = window.deyin.terminal.onData((e) => {
      if (e.id === termId) term.write(e.data);
    });
    const offExit = window.deyin.terminal.onExit((e) => {
      if (e.id === termId) term.write(`\r\n[process exited: ${e.exitCode}]\r\n`);
    });

    window.deyin.terminal
      .create({ cwd: cwd ?? undefined, cols: term.cols, rows: term.rows, shell: shellId })
      .then((id) => {
        if (disposed) {
          window.deyin.terminal.kill(id);
          return;
        }
        termId = id;
        term.onData((data) => window.deyin.terminal.write(id, data));
        term.onResize(({ cols, rows }) => window.deyin.terminal.resize(id, cols, rows));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));

    const onWindowResize = () => fit.fit();
    window.addEventListener("resize", onWindowResize);

    return () => {
      disposed = true;
      offData();
      offExit();
      window.removeEventListener("resize", onWindowResize);
      if (termId) window.deyin.terminal.kill(termId);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellId]);

  // Refit when this tab becomes visible again.
  useEffect(() => {
    if (visible) fitRef.current?.fit();
  }, [visible]);

  if (error) {
    return visible ? <div className="terminal-host hint">Terminal unavailable: {error}</div> : null;
  }
  return <div className="terminal-host" ref={hostRef} style={{ display: visible ? "block" : "none" }} />;
}
