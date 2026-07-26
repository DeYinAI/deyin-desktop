import { Icon } from "../Icon.js";
import { PageHeader } from "./controls.js";
import type { UserProfile } from "../../../shared/types.js";

interface Props {
  user: UserProfile | null;
  busy: boolean;
  onConnect: () => void;
}

const STEPS = [
  { icon: "user" as const, title: "Connect your account", detail: "Sign in with Openference to unlock models and sync." },
  { icon: "folder" as const, title: "Open a project", detail: "Point Deyin at a folder so the agent can read and edit code." },
  { icon: "terminal" as const, title: "Try the terminal", detail: "Open the integrated terminal - WSL2 shells are detected automatically." },
  { icon: "sparkles" as const, title: "Run your first task", detail: "Describe what to build; watch the plan, diff and browser panels." },
];

export function OnboardPage({ user, busy, onConnect }: Props) {
  return (
    <div className="settings-page">
      <PageHeader title="Onboard" description="Get productive with Deyin in four steps." />

      {STEPS.map((step, i) => (
        <div className="setting-card" key={i}>
          <div className="onboard-step__icon">
            <Icon name={step.icon} size={16} />
          </div>
          <div className="setting-card__meta">
            <div className="setting-card__title">{step.title}</div>
            <div className="setting-card__desc">{step.detail}</div>
          </div>
          {i === 0 && (
            <div className="setting-card__control">
              {user ? (
                <span className="badge badge--ok">Connected</span>
              ) : (
                <button className="btn btn--outline" disabled={busy} onClick={onConnect}>
                  {busy ? "Connecting..." : "Connect"}
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
