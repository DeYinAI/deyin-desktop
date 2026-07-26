import { useState } from "react";
import { Icon } from "./Icon.js";
import type { UserProfile } from "../../shared/types.js";

interface ProfileMenuProps {
  user: UserProfile | null;
  busy: boolean;
  onConnect: () => void;
  onLogout: () => void;
}

function initials(name?: string): string {
  if (!name) return "D";
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function ProfileMenu({ user, busy, onConnect, onLogout }: ProfileMenuProps) {
  const [open, setOpen] = useState(false);

  if (!user) {
    return (
      <button className="connect-row" disabled={busy} onClick={onConnect} title="Connect with Openference">
        <span className="connect-row__icon">
          <Icon name="user" size={14} />
        </span>
        <span>{busy ? "Connecting..." : "Connect"}</span>
      </button>
    );
  }

  return (
    <div className="menu">
      <button className="connect-row" onClick={() => setOpen((v) => !v)}>
        <span className="avatar avatar--small">
          {user.picture ? <img src={user.picture} alt="" /> : initials(user.name)}
        </span>
        <span className="connect-row__name">{user.name ?? user.email ?? "Signed in"}</span>
      </button>
      {open && (
        <div className="menu__panel" style={{ bottom: "calc(100% + 6px)", top: "auto", left: 0, right: "auto" }}>
          <div className="profile-card">
            <div className="profile-card__name">{user.name ?? "Deyin user"}</div>
            <div className="profile-card__email">{user.email}</div>
            {user.plan && <span className="plan-badge">{user.plan}</span>}
          </div>
          <button
            className="menu__item"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
