import { Icon, type IconName } from "../Icon.js";
import { PageHeader } from "./controls.js";
import type { DeyinSettings, UserProfile } from "../../../shared/types.js";

interface Props {
  user: UserProfile | null;
  busy: boolean;
  settings: DeyinSettings;
  onConnect: () => void;
  onOpenFolder: () => void;
  onOpenTerminal: () => void;
  onStartTask: () => void;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

interface Step {
  icon: IconName;
  title: string;
  detail: string;
  done: boolean;
  action?: { label: string; run: () => void; disabled?: boolean };
}

/** Interactive onboarding checklist; completion is computed from real app state. */
export function OnboardPage(props: Props) {
  const { onboard } = props.settings;
  const steps: Step[] = [
    {
      icon: "user",
      title: "Connect your account",
      detail: "Sign in with Openference to unlock models and sync.",
      done: props.user !== null,
      action: props.user
        ? undefined
        : { label: props.busy ? "Connecting…" : "Connect", run: props.onConnect, disabled: props.busy },
    },
    {
      icon: "folder",
      title: "Open a project",
      detail: "Point Deyin at a folder so the agent can read and edit code.",
      done: onboard.workspaceOpened,
      action: onboard.workspaceOpened ? undefined : { label: "Open folder", run: props.onOpenFolder },
    },
    {
      icon: "terminal",
      title: "Try the terminal",
      detail: "Open the integrated terminal — WSL2 shells are detected automatically.",
      done: onboard.terminalUsed,
      action: onboard.terminalUsed ? undefined : { label: "Open terminal", run: props.onOpenTerminal },
    },
    {
      icon: "sparkles",
      title: "Run your first task",
      detail: "Describe what to build; watch the tool calls, plan and diffs stream in.",
      done: onboard.taskRun,
      action: onboard.taskRun ? undefined : { label: "Start a task", run: props.onStartTask },
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  return (
    <div className="settings-page">
      <PageHeader
        title="Onboard"
        description={
          allDone
            ? "All set — you have completed every step."
            : `Get productive with Deyin in four steps. ${doneCount}/${steps.length} done.`
        }
      >
        {allDone ? (
          <span className="badge badge--ok">Complete</span>
        ) : (
          <span className="badge badge--muted">
            {doneCount}/{steps.length}
          </span>
        )}
      </PageHeader>

      {steps.map((step, i) => (
        <div className={`setting-card ${step.done ? "setting-card--done" : ""}`} key={i}>
          <div className={`onboard-step__icon ${step.done ? "onboard-step__icon--done" : ""}`}>
            <Icon name={step.done ? "check" : step.icon} size={16} />
          </div>
          <div className="setting-card__meta">
            <div className="setting-card__title">{step.title}</div>
            <div className="setting-card__desc">{step.detail}</div>
          </div>
          <div className="setting-card__control">
            {step.done ? (
              <span className="badge badge--ok">Done</span>
            ) : (
              step.action && (
                <button className="btn btn--outline" disabled={step.action.disabled} onClick={step.action.run}>
                  {step.action.label}
                </button>
              )
            )}
          </div>
        </div>
      ))}

      {(onboard.workspaceOpened || onboard.terminalUsed || onboard.taskRun) && (
        <button
          className="chip chip--small"
          style={{ marginTop: 10 }}
          onClick={() => props.onChange({ onboard: { workspaceOpened: false, terminalUsed: false, taskRun: false } })}
        >
          Reset progress
        </button>
      )}
    </div>
  );
}
