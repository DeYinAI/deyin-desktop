import { useEffect, useRef, useState, type FormEvent } from "react";
import { PERMISSION_LIMITS, type BotApprovalMode, type BotPermissionSettings, type DeyinBot, type ToolPermission } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { Toggle } from "../components/settings/controls.js";
import { submitBotForm } from "./botForm.js";
import {
  APPROVAL_MODE_OPTIONS,
  PERMISSION_OPTIONS,
  addRulePatch,
  attemptPermissionLoad,
  attemptPermissionUpdate,
  emptyPermissionForm,
  isToolPermission,
  permissionFormPatch,
  permissionFormProblem,
  permissionRows,
  removeRulePatch,
  rowLabelKey,
  rowPatch,
  ruleProblem,
  type InstructionList,
  type PermissionForm,
  type PermissionKind,
  type PermissionRow,
  type PermissionsApi,
} from "./botPermissions.js";
import type { BotsApi } from "./botsClient.js";

export type PermissionsState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; settings: BotPermissionSettings };

const KINDS: readonly PermissionKind[] = ["tool", "reads", "writes"];

export interface BotPermissionsPanelProps {
  mode: BotApprovalMode;
  state: PermissionsState;
  /** Something is being saved; the controls wait. */
  busy: boolean;
  error: string | null;
  /** What is typed in each rule box. */
  drafts: Record<InstructionList, string>;
  form: PermissionForm;
  onMode: (mode: BotApprovalMode) => void;
  onReviewEnabled: (enabled: boolean) => void;
  onDraft: (list: InstructionList, text: string) => void;
  onAddRule: (list: InstructionList) => void;
  onRemoveRule: (list: InstructionList, rule: string) => void;
  onRowPermission: (row: PermissionRow, permission: ToolPermission) => void;
  onResetRow: (row: PermissionRow) => void;
  onForm: (patch: Partial<PermissionForm>) => void;
  onAddPermission: () => void;
}

/** What a Bot may do on its own: how it is approved, the rules Auto Review applies, and the tools a person has set. */
export function BotPermissionsPanel(props: BotPermissionsPanelProps) {
  const t = useT();
  const { state, busy } = props;
  return (
    <section className="bot-permissions" aria-label={t("bot.permissions.title")}>
      <h3 className="bot-detail__heading">{t("bot.permissions.title")}</h3>
      <p className="hint">{t("bot.permissions.hint")}</p>

      <fieldset className="bot-permissions__modes" disabled={busy}>
        <legend className="field__label">{t("bot.permissions.mode")}</legend>
        {APPROVAL_MODE_OPTIONS.map((option) => (
          <label key={option.mode} className="bot-permissions__mode">
            <input type="radio" name="bot-approval-mode" value={option.mode} checked={props.mode === option.mode} onChange={() => props.onMode(option.mode)} />
            <span className="bot-permissions__mode-text">
              <strong>{t(option.label)}</strong>
              <span className="hint">{t(option.hint)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {state.status === "loading" ? (
        <p className="hint" role="status">
          {t("bot.permissions.loading")}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="hint--bad" role="alert">
          {t("bot.permissions.loadError")} {state.error}
        </p>
      ) : null}
      {state.status === "ready" ? <ReadyPanels {...props} settings={state.settings} /> : null}

      <p className="hint--bad" role="alert" hidden={!props.error}>
        {props.error}
      </p>
    </section>
  );
}

function ReadyPanels(props: BotPermissionsPanelProps & { settings: BotPermissionSettings }) {
  const t = useT();
  const { settings, busy } = props;
  const rows = permissionRows(settings);
  const formProblem = permissionFormProblem(props.form);
  const submitPermission = (event: FormEvent): void => {
    event.preventDefault();
    props.onAddPermission();
  };
  return (
    <>
      <div className="bot-permissions__review">
        <h4 className="bot-detail__subheading">{t("bot.permissions.review")}</h4>
        <p className="hint">{t("bot.permissions.reviewHint")}</p>
        <label className="bot-permissions__switch">
          <Toggle checked={settings.autoReview.enabled} disabled={busy} onChange={props.onReviewEnabled} label={t("bot.permissions.reviewEnabled")} />
          <span>{t("bot.permissions.reviewEnabled")}</span>
        </label>
        <RuleList list="allowInstructions" title={t("bot.permissions.allow")} hint={t("bot.permissions.allowHint")} placeholder={t("bot.permissions.allowPlaceholder")} {...props} />
        <RuleList list="blockInstructions" title={t("bot.permissions.block")} hint={t("bot.permissions.blockHint")} placeholder={t("bot.permissions.blockPlaceholder")} {...props} />
      </div>

      <div className="bot-permissions__tools">
        <h4 className="bot-detail__subheading">{t("bot.permissions.tools")}</h4>
        <p className="hint">{t("bot.permissions.toolsHint")}</p>
        {rows.length === 0 ? (
          <p className="hint">{t("bot.permissions.noTools")}</p>
        ) : (
          <ul className="bot-permissions__list">
            {rows.map((row) => {
              const label = fill(t(rowLabelKey(row)), { group: row.group, tool: row.tool });
              return (
                <li key={row.key} className="bot-permission">
                  <span className="bot-permission__name">{label}</span>
                  <select
                    className="input bot-permission__select"
                    aria-label={label}
                    value={row.permission}
                    disabled={busy}
                    onChange={(event) => {
                      if (isToolPermission(event.target.value)) props.onRowPermission(row, event.target.value);
                    }}
                  >
                    {PERMISSION_OPTIONS.map((option) => (
                      <option key={option.permission} value={option.permission}>
                        {t(option.label)}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => props.onResetRow(row)}>
                    {t("bot.permissions.reset")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <form className="bot-permissions__add" onSubmit={submitPermission} aria-label={t("bot.permissions.addTool")}>
          <div className="field">
            <label className="field__label" htmlFor="bot-permission-group">
              {t("bot.permissions.group")}
            </label>
            <input
              id="bot-permission-group"
              className="input"
              value={props.form.group}
              maxLength={PERMISSION_LIMITS.nameLength}
              placeholder={t("bot.permissions.groupPlaceholder")}
              autoComplete="off"
              onChange={(event) => props.onForm({ group: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="bot-permission-kind">
              {t("bot.permissions.applyTo")}
            </label>
            <select
              id="bot-permission-kind"
              className="input"
              value={props.form.kind}
              onChange={(event) => {
                const kind = KINDS.find((candidate) => candidate === event.target.value);
                if (kind) props.onForm({ kind });
              }}
            >
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`bot.permissions.kind.${kind}` as const)}
                </option>
              ))}
            </select>
          </div>
          {props.form.kind === "tool" ? (
            <div className="field">
              <label className="field__label" htmlFor="bot-permission-tool">
                {t("bot.permissions.tool")}
              </label>
              <input
                id="bot-permission-tool"
                className="input"
                value={props.form.tool}
                maxLength={PERMISSION_LIMITS.nameLength}
                placeholder={t("bot.permissions.toolPlaceholder")}
                autoComplete="off"
                onChange={(event) => props.onForm({ tool: event.target.value })}
              />
            </div>
          ) : null}
          <div className="field">
            <label className="field__label" htmlFor="bot-permission-value">
              {t("bot.permissions.setTo")}
            </label>
            <select
              id="bot-permission-value"
              className="input"
              value={props.form.permission}
              onChange={(event) => {
                if (isToolPermission(event.target.value)) props.onForm({ permission: event.target.value });
              }}
            >
              {PERMISSION_OPTIONS.map((option) => (
                <option key={option.permission} value={option.permission}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </div>
          <div className="bot-permissions__buttons">
            <button type="submit" className="btn btn--outline" disabled={busy || formProblem !== null} title={formProblem ? t(formProblem) : undefined}>
              {t("bot.permissions.addTool")}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

interface RuleListProps extends BotPermissionsPanelProps {
  settings: BotPermissionSettings;
  list: InstructionList;
  title: string;
  hint: string;
  placeholder: string;
}

function RuleList({ list, title, hint, placeholder, settings, drafts, busy, onDraft, onAddRule, onRemoveRule }: RuleListProps) {
  const t = useT();
  const rules = settings.autoReview[list];
  const draft = drafts[list];
  const problem = draft.trim() ? ruleProblem(draft, rules) : null;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onAddRule(list);
  };
  const inputId = `bot-rule-${list}`;
  return (
    <div className="bot-permissions__rules">
      <label className="field__label" htmlFor={inputId}>
        {title}
      </label>
      <span className="hint">{hint}</span>
      {rules.length === 0 ? (
        <p className="hint">{t("bot.permissions.noRules")}</p>
      ) : (
        <ul className="bot-permissions__list">
          {rules.map((rule) => (
            <li key={rule} className="bot-permission">
              <span className="bot-permission__name">{rule}</span>
              <button type="button" className="btn btn--ghost" disabled={busy} aria-label={`${t("bot.permissions.remove")}: ${rule}`} onClick={() => onRemoveRule(list, rule)}>
                {t("bot.permissions.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="bot-permissions__rule-add" onSubmit={submit}>
        <input
          id={inputId}
          className="input"
          value={draft}
          maxLength={PERMISSION_LIMITS.instructionLength}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(event) => onDraft(list, event.target.value)}
        />
        <button type="submit" className="btn btn--outline" disabled={busy || !draft.trim() || problem !== null}>
          {t("bot.permissions.add")}
        </button>
      </form>
      {problem ? (
        <p className="hint--bad" role="alert">
          {t(problem)}
        </p>
      ) : null}
    </div>
  );
}

interface BotPermissionsProps {
  bot: DeyinBot;
  actions: BotsApi;
  api: PermissionsApi;
}

/**
 * The Bot's permissions page section. The approval mode is the Bot's own, so it is saved on the Bot; the rules
 * and tool permissions are account-wide, so they are saved through the permission API and read back when
 * another window, or "Always allow" on an approval card, changes them.
 */
export function BotPermissions({ bot, actions, api }: BotPermissionsProps) {
  const [state, setState] = useState<PermissionsState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<InstructionList, string>>({ allowInstructions: "", blockInstructions: "" });
  const [form, setForm] = useState<PermissionForm>(emptyPermissionForm);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    const stop = api.onChange((settings) => {
      if (current) setState({ status: "ready", settings });
    });
    void attemptPermissionLoad(api).then((outcome) => {
      if (!current) return;
      // A change that arrived while loading is newer than the answer.
      setState((existing) => (existing.status === "ready" ? existing : outcome.ok ? { status: "ready", settings: outcome.settings } : { status: "error", error: outcome.error }));
    });
    return () => {
      current = false;
      stop();
    };
  }, [api]);

  /** Run one change, hold the controls while it saves, and show a refusal. */
  const change = async (run: () => Promise<{ ok: true; settings?: BotPermissionSettings } | { ok: false; error: string }>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const outcome = await run();
    if (!mounted.current) return false;
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return false;
    }
    if (outcome.settings) setState({ status: "ready", settings: outcome.settings });
    return true;
  };
  const update = (patch: unknown): Promise<boolean> => change(() => attemptPermissionUpdate(api, patch));
  const existing = state.status === "ready" ? state.settings.autoReview : null;

  return (
    <BotPermissionsPanel
      mode={bot.autoReview.approvalMode}
      state={state}
      busy={busy}
      error={error}
      drafts={drafts}
      form={form}
      onMode={(mode) => {
        if (mode === bot.autoReview.approvalMode) return;
        void change(async () => {
          const outcome = await submitBotForm(() => actions.update(bot.id, { approvalMode: mode }));
          return outcome.kind === "done" ? { ok: true } : { ok: false, error: outcome.error };
        });
      }}
      onReviewEnabled={(enabled) => void update({ autoReview: { enabled } })}
      onDraft={(list, text) => setDrafts((current) => ({ ...current, [list]: text }))}
      onAddRule={(list) => {
        if (!existing) return;
        const patch = addRulePatch(list, existing[list], drafts[list]);
        if (!patch) return;
        void update(patch).then((saved) => {
          if (saved && mounted.current) setDrafts((current) => ({ ...current, [list]: "" }));
        });
      }}
      onRemoveRule={(list, rule) => {
        if (existing) void update(removeRulePatch(list, existing[list], rule));
      }}
      onRowPermission={(row, permission) => void update(rowPatch(row, permission))}
      onResetRow={(row) => void update(rowPatch(row, null))}
      onForm={(patch) => setForm((current) => ({ ...current, ...patch }))}
      onAddPermission={() => {
        const patch = permissionFormPatch(form);
        if (!patch) return;
        void update(patch).then((saved) => {
          if (saved && mounted.current) setForm((current) => ({ ...emptyPermissionForm(), group: current.group }));
        });
      }}
    />
  );
}
