import { useRef, useState } from "react";
import { Icon } from "./Icon.js";
import { useMenuDismiss } from "../hooks/useMenuDismiss.js";
import type { EnvInfo } from "@deyin/contract";

interface EnvironmentBadgeProps {
  env: EnvInfo | null;
  onPickShell: (shellId: string) => void;
}

/** Top-bar badge showing the active execution environment (Local / WSL2 / web sandbox). */
export function EnvironmentBadge({ env, onPickShell }: EnvironmentBadgeProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useMenuDismiss(open, () => setOpen(false), anchorRef, panelRef);

  if (!env) {
    return (
      <span className="env-badge env-badge--muted">
        <Icon name="cpu" size={12} />
        <span>Detecting…</span>
      </span>
    );
  }

  const label =
    env.platform === "web"
      ? "Sandbox"
      : env.platform === "win32" && env.wsl2
        ? `WSL2 · ${env.wslDistros[0] ?? "Linux"}`
        : env.wsl2
          ? "WSL2 · Linux"
          : `Local · ${env.platform}`;

  return (
    <div className="menu">
      <button
        ref={anchorRef}
        className="env-badge"
        title={`Host: ${env.hostname} (${env.arch})`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="cpu" size={12} />
        <span>{label}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {open && (
        <div className="menu__panel" ref={panelRef}>
          <div className="menu__header">Environment</div>
          <div className="menu__info">
            <div>Host: {env.hostname}</div>
            <div>Platform: {env.platform} ({env.arch})</div>
            <div>WSL2: {env.wsl2 ? "available" : "not detected"}</div>
          </div>
          <div className="menu__header">Shells</div>
          {env.shells.map((shell) => (
            <button
              key={shell.id}
              className="menu__item"
              onClick={() => {
                onPickShell(shell.id);
                setOpen(false);
              }}
            >
              <Icon name="terminal" size={13} />
              {shell.label}
              {shell.kind === "wsl" && <span className="badge badge--quota">WSL2</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
