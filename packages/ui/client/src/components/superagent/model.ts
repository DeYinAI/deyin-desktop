/** Pure helpers behind the Superagent view: labels, and the edits the settings form makes to a settings object. */
import type { ModelInfo } from "@deyin/contract";
import {
  ADMISSION_DEFAULTS,
  ADMISSION_OPTIONS,
  GITHUB_ROWS,
  type Allowed,
  type ModelRef,
  type Rule,
  type Settings,
  type SuperagentStatus,
  type TicketCardState,
} from "@deyin/superagent/client";
import type { MenuSelectOption } from "../MenuSelect.js";

export type Tone = "muted" | "ok" | "warn" | "bad";
export interface Label {
  label: string;
  tone: Tone;
}

/** The one-word state of Superagent as a whole. */
export function overallState(status: SuperagentStatus): Label {
  if (!status.ready) return { label: "Needs setup", tone: "warn" };
  if (!status.enabled) return { label: "Off", tone: "muted" };
  if (status.paused) return { label: "Paused", tone: "warn" };
  switch (status.mode) {
    case "off":
      return { label: "Mentions only", tone: "ok" };
    case "observe":
      return { label: "Observing", tone: "ok" };
    case "auto":
      return { label: "Active", tone: "ok" };
    default: {
      const never: never = status.mode;
      throw new Error(`Unhandled mode ${String(never)}`);
    }
  }
}

// ---- run state ------------------------------------------------------------------------------------------------------

/** What the header's one control sets: the two switches it replaces, as a single choice. */
export type RunState = "on" | "paused" | "off";

export function runStateOf(settings: Pick<Settings, "enabled" | "paused">): RunState {
  if (!settings.enabled) return "off";
  return settings.paused ? "paused" : "on";
}

/** The settings with Superagent in `state`. Pausing needs it enabled, so Paused turns it on; On and Off clear the pause. */
export function withRunState(settings: Settings, state: RunState): Settings {
  switch (state) {
    case "on":
      return { ...settings, enabled: true, paused: false };
    case "paused":
      return { ...settings, enabled: true, paused: true };
    case "off":
      return { ...settings, enabled: false, paused: false };
    default: {
      const never: never = state;
      throw new Error(`Unhandled run state ${String(never)}`);
    }
  }
}

const RUN_STATE_LABELS: Record<RunState, string> = { on: "On", paused: "Paused", off: "Off" };
const RUN_STATE_ORDER: readonly RunState[] = ["on", "paused", "off"];

/** The header control's choices. Until the setup is complete Superagent cannot run, so On and Paused say why they are unavailable. */
export function runStateOptions(canRun: boolean): MenuSelectOption<RunState>[] {
  return RUN_STATE_ORDER.map((id) => {
    const unavailable = id !== "off" && !canRun;
    return { id, label: RUN_STATE_LABELS[id], disabled: unavailable, hint: unavailable ? "Finish setup first" : undefined };
  });
}

const TICKET_LABELS: Record<TicketCardState, Label> = {
  "person/review": { label: "Ready for review", tone: "ok" },
  "person/answer": { label: "Needs an answer", tone: "warn" },
  "person/blocked": { label: "Blocked", tone: "warn" },
  "person/delivery": { label: "Reply not delivered", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  working: { label: "Working", tone: "ok" },
  "working/queued": { label: "Queued", tone: "muted" },
  idle: { label: "Waiting", tone: "muted" },
  completed: { label: "Completed", tone: "ok" },
  merged: { label: "Merged", tone: "ok" },
  closed: { label: "Closed", tone: "muted" },
  dropped: { label: "Dropped", tone: "muted" },
  stopped: { label: "Stopped", tone: "muted" },
};

export const ticketLabel = (state: TicketCardState): Label => TICKET_LABELS[state];

/** Tickets that still need a person's attention, ahead of the rest in a list. */
export function needsPerson(state: TicketCardState): boolean {
  return state === "person/answer" || state === "person/blocked" || state === "person/delivery" || state === "failed";
}

// ---- models ---------------------------------------------------------------------------------------------------------

/** A select value for a model reference; the empty string is the app's default model. */
export const modelValue = (model: ModelRef | null): string => (model ? `${model.providerId}::${model.model}` : "");

/**
 * The model choices: the app's default first, then the chat models of the selected provider. Image and video models cannot answer
 * messages. A model already stored stays listed even when the provider no longer offers it, so opening the page never changes it.
 */
export function modelOptions(models: readonly ModelInfo[], providerId: string, current: ModelRef | null): MenuSelectOption[] {
  const options = models
    .filter((model) => model.kind !== "image" && model.kind !== "video")
    .map((model) => ({ id: `${providerId}::${model.id}`, label: model.id }));
  const value = modelValue(current);
  if (value && !options.some((option) => option.id === value)) options.unshift({ id: value, label: value.replace("::", " · ") });
  return [{ id: "", label: "The app's default model" }, ...options];
}

export function parseModelValue(value: string): ModelRef | null {
  const at = value.indexOf("::");
  if (at <= 0 || at + 2 >= value.length) return null;
  return { providerId: value.slice(0, at), model: value.slice(at + 2) };
}

// ---- text lists -----------------------------------------------------------------------------------------------------

/** GitHub logins, one per line (an `@` is allowed); a login already listed keeps its display name. */
export function parseAccounts(text: string, previous: readonly Allowed[]): Allowed[] {
  const seen = new Set<string>();
  const accounts: Allowed[] = [];
  for (const line of text.split(/[\n,]+/)) {
    const id = line.trim().replace(/^@/, "").trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const known = previous.find((entry) => entry.id.toLowerCase() === id.toLowerCase());
    accounts.push(known?.name ? { id, name: known.name } : { id });
  }
  return accounts;
}

export const accountsText = (accounts: readonly Allowed[]): string => accounts.map((entry) => entry.id).join("\n");

/** Command names separated by spaces, commas or lines. */
export function parseCommands(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

export const commandsText = (commands: readonly string[]): string => commands.join(" ");

// ---- policy edits ---------------------------------------------------------------------------------------------------

type SourcePolicy = NonNullable<Settings["policy"]["sources"]["github"]>;
const EMPTY_SOURCE: SourcePolicy = { allowed: [], bots: [], admission: {} };

export const githubPolicy = (settings: Settings): SourcePolicy => settings.policy.sources.github ?? EMPTY_SOURCE;

export function withGithubPolicy(settings: Settings, patch: Partial<SourcePolicy>): Settings {
  return { ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, github: { ...githubPolicy(settings), ...patch } } } };
}

export type AdmissionRow = "issues" | "pulls" | "comments";
export type AdmissionCell = keyof typeof ADMISSION_DEFAULTS;

const ADMISSION_LABELS: Record<string, string> = {
  explicit: "Treat as a request",
  inferred: "Let the agent decide",
  ignore: "Ignore",
};

/** The choices a cell allows; they differ by cell, and only one cell allows all three. */
export const admissionOptions = (cell: AdmissionCell): MenuSelectOption[] =>
  ADMISSION_OPTIONS[cell].map((id) => ({ id, label: ADMISSION_LABELS[id] ?? id }));

/** What the table says for a row and cell; an unset cell has the default. */
export function admissionValue(settings: Settings, row: AdmissionRow, cell: AdmissionCell): string {
  return githubPolicy(settings).admission[row]?.[cell] ?? ADMISSION_DEFAULTS[cell];
}

/**
 * The one cell the settings page offers per row without opening the table of Advanced policy: what happens when someone who is not on the
 * allowed list addresses the agent. It is the only cell that allows all three choices (a request, an assessed candidate, or nothing).
 */
export const HEADLINE_CELL = "unlistedAddressed" satisfies AdmissionCell;

/**
 * Every cell of the table, the headline one included, that differs from its default. The settings page keeps all of the policy
 * under a closed Advanced section, so it opens by itself when this is not empty: a policy that lets something through must not be hidden.
 */
export function changedPolicyCells(settings: Settings): { row: AdmissionRow; cell: AdmissionCell }[] {
  const cells = Object.keys(ADMISSION_DEFAULTS) as AdmissionCell[];
  return GITHUB_ROWS.flatMap((row) => cells.filter((cell) => admissionValue(settings, row, cell) !== ADMISSION_DEFAULTS[cell]).map((cell) => ({ row, cell })));
}

/** The changed cells other than the headline one: they only appear in the table under Advanced policy, so the page counts them. */
export function changedAdvancedCells(settings: Settings): { row: AdmissionRow; cell: AdmissionCell }[] {
  return changedPolicyCells(settings).filter(({ cell }) => cell !== HEADLINE_CELL);
}

export function withAdmission(settings: Settings, row: AdmissionRow, cell: AdmissionCell, value: string): Settings {
  const policy = githubPolicy(settings);
  const current = policy.admission[row] ?? {};
  return withGithubPolicy(settings, { admission: { ...policy.admission, [row]: { ...current, [cell]: value } } } as Partial<SourcePolicy>);
}

// ---- rules ----------------------------------------------------------------------------------------------------------

/** An id for a new rule: its name as a slug, made unique among `taken`. */
export function newRuleId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "rule";
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

export const blankRule = (taken: readonly string[]): Rule => ({ id: newRuleId("new rule", taken), name: "New rule", enabled: true, instruction: "" });

export function withRule(settings: Settings, id: string, patch: Partial<Rule>): Settings {
  return { ...settings, policy: { ...settings.policy, rules: settings.policy.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)) } };
}

// ---- time and comparison --------------------------------------------------------------------------------------------

export function timeAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

/**
 * Whether two settings are the same apart from the on and pause switches, which the page header flips on its own and which the
 * settings form never edits.
 */
export const sameEditable = (a: Settings, b: Settings): boolean => JSON.stringify({ ...a, enabled: false, paused: false }) === JSON.stringify({ ...b, enabled: false, paused: false });
