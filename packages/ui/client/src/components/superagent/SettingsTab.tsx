import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo } from "@deyin/contract";
import { ADMISSION_OPTIONS, SETTINGS_LIMITS, type Settings, type SuperagentView } from "@deyin/superagent/client";
import { useConfirm } from "../ConfirmDialog.js";
import { Callout } from "../ui/index.js";
import { Field, FormSection, SettingCard, Toggle } from "../settings/controls.js";
import { AccountSection } from "./AccountSection.js";
import {
  accountsText,
  admissionValue,
  blankRule,
  commandsText,
  githubPolicy,
  modelValue,
  parseAccounts,
  parseCommands,
  parseModelValue,
  sameEditable,
  withAdmission,
  withGithubPolicy,
  withRule,
  type AdmissionCell,
  type AdmissionRow,
} from "./model.js";
import type { SuperagentController } from "./useSuperagent.js";

const ROWS: { id: AdmissionRow; label: string }[] = [
  { id: "issues", label: "Issues" },
  { id: "pulls", label: "Pull requests" },
  { id: "comments", label: "Comments" },
];

const CELLS: { id: AdmissionCell; label: string; hint: string }[] = [
  { id: "listedUnaddressed", label: "Allowed account, not addressed to the agent", hint: "A message from an account on the list that does not mention the agent." },
  { id: "unlistedAddressed", label: "Anyone else, addressed to the agent", hint: "A mention of the agent from an account that is not on the list." },
  { id: "unlistedUnaddressed", label: "Anyone else, not addressed to the agent", hint: "Any other message." },
];

const ADMISSION_LABELS: Record<string, string> = {
  explicit: "Treat as a request",
  inferred: "Let the agent decide",
  ignore: "Ignore",
};

function ModelSelect(props: { value: Settings["eval"]["model"]; models: ModelInfo[]; providerId: string; onChange: (model: Settings["eval"]["model"]) => void }) {
  const chat = props.models.filter((model) => model.kind !== "image" && model.kind !== "video");
  const current = modelValue(props.value);
  const options = chat.map((model) => ({ value: `${props.providerId}::${model.id}`, label: model.id }));
  if (current && !options.some((option) => option.value === current)) options.unshift({ value: current, label: current.replace("::", " · ") });
  return (
    <select className="select" value={current} onChange={(event) => props.onChange(parseModelValue(event.target.value))}>
      <option value="">The app's default model</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function Text(props: { value: string; onChange: (value: string) => void; mono?: boolean; placeholder?: string; max?: number; label?: string }) {
  return (
    <input
      className={`input${props.mono ? " input-mono" : ""}`}
      value={props.value}
      placeholder={props.placeholder}
      maxLength={props.max}
      aria-label={props.label}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

/** A number the person is typing: only a number reaches the draft, and what was typed stays on screen until the field is left. */
function NumberField(props: { value: number; min: number; max: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(props.value));
  const focused = useRef(false);
  // Not rewritten under the cursor ("007" would become "7" while it is typed); it settles when the field is left.
  useEffect(() => {
    if (!focused.current) setText(String(props.value));
  }, [props.value]);
  return (
    <input
      className="input input--narrow"
      type="number"
      min={props.min}
      max={props.max}
      value={text}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(event) => {
        setText(event.target.value);
        const value = Number(event.target.value);
        if (event.target.value.trim() !== "" && Number.isFinite(value)) props.onChange(value);
      }}
      onBlur={() => {
        focused.current = false;
        setText(String(props.value));
      }}
    />
  );
}

function Lines(props: { value: string; rows?: number; onCommit: (value: string) => void; placeholder?: string; mono?: boolean }) {
  // What was typed stays as typed while the field has focus (a trailing newline or "@" is not rewritten under the cursor), and every
  // change reaches the draft at once, so Save and the switches in the header always act on what is on screen.
  const [text, setText] = useState(props.value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(props.value);
  }, [props.value]);
  return (
    <textarea
      className={`input${props.mono ? " input-mono" : ""}`}
      rows={props.rows ?? 4}
      value={text}
      placeholder={props.placeholder}
      spellCheck={false}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(event) => {
        setText(event.target.value);
        props.onCommit(event.target.value);
      }}
      onBlur={() => {
        focused.current = false;
        setText(props.value);
      }}
    />
  );
}

export function SettingsTab(props: { view: SuperagentView; controller: SuperagentController; models: ModelInfo[]; providerId: string }) {
  const { view, controller } = props;
  const { confirm } = useConfirm();
  const [draft, setDraft] = useState<Settings>(view.settings);
  // The settings the draft was started from, and the revision they had.
  const [base, setBase] = useState({ revision: view.settingsRevision, settings: view.settings });
  const dirty = useMemo(() => !sameEditable(draft, base.settings), [draft, base.settings]);

  // A change from elsewhere (a reset, another window) replaces an untouched form. An edited one is left alone, and its save is
  // refused (it names the revision it started from) until the person discards it. A flip of the header's switches is no conflict.
  useEffect(() => {
    if (view.settingsRevision === base.revision) return;
    if (sameEditable(view.settings, base.settings)) setBase({ revision: view.settingsRevision, settings: view.settings });
    else if (!dirty) {
      setDraft(view.settings);
      setBase({ revision: view.settingsRevision, settings: view.settings });
    }
  }, [view.settings, view.settingsRevision, base, dirty]);

  const api = window.deyin.superagent;
  const edit = (change: (current: Settings) => Settings) => setDraft((current) => change(current));
  const github = githubPolicy(draft);
  const save = async () => {
    if (!api) return;
    const saved = await controller.act(() => api.saveSettings({ ...draft, enabled: view.settings.enabled, paused: view.settings.paused }, base.revision));
    if (saved) {
      // What was stored may differ from what was typed (trimmed, deduplicated); show what is in effect.
      setDraft(saved.settings);
      setBase({ revision: saved.settingsRevision, settings: saved.settings });
    }
  };
  const discard = () => {
    setDraft(view.settings);
    setBase({ revision: view.settingsRevision, settings: view.settings });
  };
  const reset = async () => {
    if (!api) return;
    const ok = await confirm({
      message: "Reset Superagent? All tickets, decisions and conversations are deleted and every setting returns to its default. The GitHub token stays. Worktrees on disk are not touched.",
      destructive: true,
    });
    if (ok) await controller.act(() => api.reset());
  };

  return (
    <>
      <AccountSection view={view} controller={controller} />

      <FormSection title="Repository" note="Superagent watches one repository">
        <Field label="Repository" hint="owner/name, for example acme/app. It cannot change while tickets are open.">
          <Text mono value={draft.github.repository} placeholder="owner/name" onChange={(repository) => edit((s) => ({ ...s, github: { ...s.github, repository } }))} />
        </Field>
        <SettingCard title="Watch issues" description="New issues and the comments on them.">
          <Toggle checked={draft.github.observeIssues} onChange={(observeIssues) => edit((s) => ({ ...s, github: { ...s.github, observeIssues } }))} />
        </SettingCard>
        <SettingCard title="Watch pull requests" description="New pull requests, reviews and review comments.">
          <Toggle checked={draft.github.observePulls} onChange={(observePulls) => edit((s) => ({ ...s, github: { ...s.github, observePulls } }))} />
        </SettingCard>
        <SettingCard title="Watch comments" description="Conversation comments, mentions included, anywhere in the repository.">
          <Toggle checked={draft.github.observeComments} onChange={(observeComments) => edit((s) => ({ ...s, github: { ...s.github, observeComments } }))} />
        </SettingCard>
        <SettingCard title="Check GitHub every" description={`Seconds between polls, ${SETTINGS_LIMITS.pollSeconds.min} to ${SETTINGS_LIMITS.pollSeconds.max}.`}>
          <NumberField min={SETTINGS_LIMITS.pollSeconds.min} max={SETTINGS_LIMITS.pollSeconds.max} value={draft.github.pollSeconds} onChange={(pollSeconds) => edit((s) => ({ ...s, github: { ...s.github, pollSeconds } }))} />
        </SettingCard>
        <Field label="Branch prefix" hint="Workers open their pull requests from branches that start with this.">
          <Text mono value={draft.github.branchPrefix} onChange={(branchPrefix) => edit((s) => ({ ...s, github: { ...s.github, branchPrefix } }))} />
        </Field>
      </FormSection>

      <FormSection title="Who may ask" note="Nothing is acted on unless an allowed account asked for it">
        <Field label="Allowed accounts" hint="GitHub logins, one per line. The agent's own account must not be here.">
          <Lines mono value={accountsText(github.allowed)} placeholder="alice&#10;bob" onCommit={(text) => edit((s) => withGithubPolicy(s, { allowed: parseAccounts(text, githubPolicy(s).allowed) }))} />
        </Field>
        <Field label="Trusted bots" hint="Accounts whose messages are read as context, such as review bots, but never as a request.">
          <Lines mono rows={3} value={accountsText(github.bots)} placeholder="review-bot[bot]" onCommit={(text) => edit((s) => withGithubPolicy(s, { bots: parseAccounts(text, githubPolicy(s).bots) }))} />
        </Field>
      </FormSection>

      <FormSection title="What counts as a request" note="By where the message was written and who wrote it">
        <div className="superagent__admission">
          <span />
          {ROWS.map((row) => (
            <strong key={row.id}>{row.label}</strong>
          ))}
          {CELLS.map((cell) => (
            <div key={cell.id} className="superagent__admission-row">
              <div title={cell.hint}>{cell.label}</div>
              {ROWS.map((row) => (
                <select
                  key={row.id}
                  className="select"
                  aria-label={`${cell.label}, in ${row.label}`}
                  value={admissionValue(draft, row.id, cell.id)}
                  onChange={(event) => edit((s) => withAdmission(s, row.id, cell.id, event.target.value))}
                >
                  {ADMISSION_OPTIONS[cell.id].map((option) => (
                    <option key={option} value={option}>
                      {ADMISSION_LABELS[option] ?? option}
                    </option>
                  ))}
                </select>
              ))}
            </div>
          ))}
        </div>
      </FormSection>

      <FormSection
        title="Rules"
        note="What the agent may take on"
        action={
          <button type="button" className="btn btn--ghost btn--small" onClick={() => edit((s) => ({ ...s, policy: { ...s.policy, rules: [...s.policy.rules, blankRule(s.policy.rules.map((rule) => rule.id))] } }))}>
            Add rule
          </button>
        }
      >
        {draft.policy.rules.length === 0 && <Callout tone="warn">Without an enabled rule the agent accepts nothing.</Callout>}
        {draft.policy.rules.map((rule) => (
          <div key={rule.id} className="superagent__rule">
            <div className="superagent__rule-head">
              <Text value={rule.name} max={SETTINGS_LIMITS.ruleName} label="Rule name" onChange={(name) => edit((s) => withRule(s, rule.id, { name }))} />
              <Toggle checked={rule.enabled} onChange={(enabled) => edit((s) => withRule(s, rule.id, { enabled }))} />
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => edit((s) => ({ ...s, policy: { ...s.policy, rules: s.policy.rules.filter((item) => item.id !== rule.id) } }))}
              >
                Remove
              </button>
            </div>
            <textarea className="input" rows={4} maxLength={SETTINGS_LIMITS.ruleInstruction} aria-label="Rule instruction" value={rule.instruction} placeholder="Describe the requests this rule covers, and where it stops." onChange={(event) => edit((s) => withRule(s, rule.id, { instruction: event.target.value }))} />
          </div>
        ))}
      </FormSection>

      <FormSection title="Assessment" note="How requests are judged">
        <SettingCard title="Mode" description="Off acts only on requests that address the agent directly (an @mention from an allowed account). Observe also reads the other messages it can see and records what it would take on, without acting. Auto acts on those too, within the rules.">
          <select className="select" value={draft.eval.mode} onChange={(event) => edit((s) => ({ ...s, eval: { ...s.eval, mode: event.target.value as Settings["eval"]["mode"] } }))}>
            <option value="off">Off</option>
            <option value="observe">Observe</option>
            <option value="auto">Auto</option>
          </select>
        </SettingCard>
        <SettingCard title="Model" description="Used by the agent that reads and routes messages.">
          <ModelSelect value={draft.eval.model} models={props.models} providerId={props.providerId} onChange={(model) => edit((s) => ({ ...s, eval: { ...s.eval, model } }))} />
        </SettingCard>
        <SettingCard title="Time to decide" description={`Seconds before an assessment is dropped, ${SETTINGS_LIMITS.evalTimeoutSeconds.min} to ${SETTINGS_LIMITS.evalTimeoutSeconds.max}.`}>
          <NumberField min={SETTINGS_LIMITS.evalTimeoutSeconds.min} max={SETTINGS_LIMITS.evalTimeoutSeconds.max} value={draft.eval.timeoutSeconds} onChange={(timeoutSeconds) => edit((s) => ({ ...s, eval: { ...s.eval, timeoutSeconds } }))} />
        </SettingCard>
      </FormSection>

      <FormSection title="Workers" note="Each ticket runs in its own git worktree">
        <SettingCard title="Model" description="Used by the agents that write the code.">
          <ModelSelect value={draft.executor.model} models={props.models} providerId={props.providerId} onChange={(model) => edit((s) => ({ ...s, executor: { ...s.executor, model } }))} />
        </SettingCard>
        <SettingCard title="Parallel workers" description={`Tickets worked on at once, ${SETTINGS_LIMITS.maxWorkers.min} to ${SETTINGS_LIMITS.maxWorkers.max}.`}>
          <NumberField min={SETTINGS_LIMITS.maxWorkers.min} max={SETTINGS_LIMITS.maxWorkers.max} value={draft.executor.maxWorkers} onChange={(maxWorkers) => edit((s) => ({ ...s, executor: { ...s.executor, maxWorkers } }))} />
        </SettingCard>
        <Field label="Worktrees directory" hint="An absolute path. Empty keeps them inside Deyin's data folder.">
          <Text mono value={draft.executor.directory} onChange={(directory) => edit((s) => ({ ...s, executor: { ...s.executor, directory } }))} />
        </Field>
        <Field label="Local checkout" hint="An absolute path to a clone of the repository to branch from. Empty lets Deyin keep its own clone.">
          <Text mono value={draft.executor.checkout} onChange={(checkout) => edit((s) => ({ ...s, executor: { ...s.executor, checkout } }))} />
        </Field>
        <Field label="Blocked commands" hint="Commands a worker's shell refuses, separated by spaces. This is a best-effort screen, not a sandbox. git and gh cannot be blocked.">
          <Lines mono rows={2} value={commandsText(draft.executor.blockedCommands)} placeholder="rm curl" onCommit={(text) => edit((s) => ({ ...s, executor: { ...s.executor, blockedCommands: parseCommands(text) } }))} />
        </Field>
      </FormSection>

      <FormSection title="Instructions" note="Added to the agents' built-in prompts">
        {(
          [
            ["communication", "Communication", "How the agent talks on GitHub: language, tone, length."],
            ["scope", "Scope", "What the agent should treat as in or out of bounds, beyond the rules."],
            ["delivery", "Delivery", "How work is delivered: branch and pull-request conventions, checks to run."],
          ] as const
        ).map(([key, label, hint]) => (
          <Field key={key} label={label} hint={hint}>
            <textarea className="input" rows={4} maxLength={SETTINGS_LIMITS.promptSection} value={draft.prompts[key]} onChange={(event) => edit((s) => ({ ...s, prompts: { ...s.prompts, [key]: event.target.value } }))} />
          </Field>
        ))}
      </FormSection>

      <FormSection title="Reset">
        <SettingCard title="Reset Superagent" description="Delete all tickets, decisions and conversations, and return every setting to its default.">
          <button type="button" className="btn btn--ghost" disabled={controller.busy} onClick={() => void reset()}>
            Reset…
          </button>
        </SettingCard>
      </FormSection>

      {dirty && (
        <div className="superagent__savebar" role="region" aria-label="Unsaved settings">
          <span>Unsaved changes</span>
          <button type="button" className="btn btn--ghost" onClick={discard}>
            Discard
          </button>
          <button type="button" className="btn btn--primary" disabled={controller.busy} onClick={() => void save()}>
            Save
          </button>
        </div>
      )}
    </>
  );
}
