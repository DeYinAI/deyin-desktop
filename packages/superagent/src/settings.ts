/**
 * Superagent settings: what may originate work (policy), how candidates are assessed (eval), how work is executed (executor),
 * and what is watched (GitHub). Everything defaults to off: no repository, no allowed sender, accept mode `observe`.
 */
import { UserError } from "./core/errors.js";
import type { AcceptMode, Admission, AdmissionCell } from "./core/types.js";
import * as s from "./schema.js";
import type { Infer, Schema } from "./schema.js";

export const LIMITS = {
  ruleName: 100,
  ruleInstruction: 2000,
  evalTimeoutSeconds: { min: 30, max: 600 },
  maxWorkers: { min: 1, max: 8 },
  pollSeconds: { min: 30, max: 3600 },
  promptSection: 20_000,
} as const;

/** Commands a worker needs and therefore cannot have blocked. */
export const WORKER_COMMANDS: readonly string[] = ["gh", "git"];

export const ADMISSION_OPTIONS = {
  listedUnaddressed: ["inferred", "ignore"],
  unlistedAddressed: ["explicit", "inferred", "ignore"],
  unlistedUnaddressed: ["inferred", "ignore"],
} as const satisfies Record<AdmissionCell, readonly Admission[]>;
/** Defaults matching the pre-table behaviour: an unaddressed message from a listed sender is a candidate; unlisted senders are ignored. */
export const ADMISSION_DEFAULTS: Readonly<Record<AdmissionCell, Admission>> = {
  listedUnaddressed: "inferred",
  unlistedAddressed: "ignore",
  unlistedUnaddressed: "ignore",
};
export type AdmissionRow = { [C in AdmissionCell]?: (typeof ADMISSION_OPTIONS)[C][number] };

export const GITHUB_ROWS = ["issues", "pulls", "comments"] as const;
export type GithubRow = (typeof GITHUB_ROWS)[number];

const DEFAULT_RULES = [
  {
    id: "copy",
    name: "Copy fixes",
    enabled: true,
    instruction:
      "Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning.",
  },
  {
    id: "visual",
    name: "Visual fixes",
    enabled: true,
    instruction:
      "Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.",
  },
];

const withDefault = <T>(inner: Schema<T | undefined>, make: () => NoInfer<T>): Schema<T> => ({
  json: inner.json,
  optional: true,
  parse(value, path) {
    const parsed = value === undefined ? undefined : inner.parse(value, path);
    return parsed === undefined ? make() : parsed;
  },
});

const RuleSchema = s.object({
  id: s.string({ pattern: /^[a-zA-Z0-9_-]{1,80}$/ }),
  name: s.string({ trim: true, min: 1, max: LIMITS.ruleName }),
  enabled: s.boolean(),
  instruction: s.string({ trim: true, min: 1, max: LIMITS.ruleInstruction }),
});
export type Rule = Infer<typeof RuleSchema>;

const ModelSchema = s.object({
  providerId: s.string({ trim: true, min: 1, max: 200 }),
  model: s.string({ trim: true, min: 1, max: 200 }),
});
export type ModelRef = Infer<typeof ModelSchema>;

const AllowedSchema = s.object({
  id: s.string({ trim: true, min: 1, max: 200 }),
  name: s.optional(s.string({ trim: true, max: 100 })),
});
export type Allowed = Infer<typeof AllowedSchema>;

const weak = s.enumeration(["inferred", "ignore"] as const);
const AdmissionRowSchema = s.object({
  listedUnaddressed: s.optional(weak),
  unlistedAddressed: s.optional(s.enumeration(["explicit", "inferred", "ignore"] as const)),
  unlistedUnaddressed: s.optional(weak),
});
const SourcePolicySchema = s.object({
  allowed: withDefault(s.array(AllowedSchema, { max: 500 }), () => []),
  bots: withDefault(s.array(AllowedSchema, { max: 100 }), () => []),
  admission: withDefault(s.object({ issues: s.optional(AdmissionRowSchema), pulls: s.optional(AdmissionRowSchema), comments: s.optional(AdmissionRowSchema) }), () => ({})),
});
export type SourcePolicy = Infer<typeof SourcePolicySchema>;

const CommandNameSchema = s.string({
  pattern: /^[A-Za-z0-9._-]+$/,
  max: 64,
  check: (name) => (name === "." || name === ".." ? "not a command name" : WORKER_COMMANDS.includes(name) ? `${WORKER_COMMANDS.join(", ")} cannot be blocked` : undefined),
});

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const GithubSchema = s.object({
  repository: withDefault(s.string({ trim: true, check: (value) => (value === "" || REPOSITORY.test(value) ? undefined : "write it as owner/name") }), () => ""),
  pollSeconds: withDefault(s.number({ int: true, ...LIMITS.pollSeconds }), () => 60),
  observeIssues: withDefault(s.boolean(), () => false),
  observePulls: withDefault(s.boolean(), () => false),
  observeComments: withDefault(s.boolean(), () => false),
  /** Prefix of the branch a worker opens its PR from; the last path segment is the worktree name. */
  branchPrefix: withDefault(s.string({ trim: true, max: 40, pattern: /^[A-Za-z0-9._/-]*$/ }), () => "agent/"),
});

const SettingsSchema = s.object({
  enabled: withDefault(s.boolean(), () => false),
  paused: withDefault(s.boolean(), () => false),
  github: withDefault(GithubSchema, () => GithubSchema.parse({})),
  policy: withDefault(
    s.object({
      rules: withDefault(s.array(RuleSchema, { max: 50 }), () => DEFAULT_RULES.map((rule) => ({ ...rule }))),
      sources: withDefault(s.object({ github: s.optional(SourcePolicySchema) }), () => ({})),
    }),
    () => ({ rules: DEFAULT_RULES.map((rule) => ({ ...rule })), sources: {} }),
  ),
  eval: withDefault(
    s.object({
      mode: withDefault(s.enumeration(["off", "observe", "auto"] as const), () => "observe" as AcceptMode),
      timeoutSeconds: withDefault(s.number({ int: true, ...LIMITS.evalTimeoutSeconds }), () => 120),
      model: withDefault(s.nullish(ModelSchema), () => null),
    }),
    () => ({ mode: "observe" as AcceptMode, timeoutSeconds: 120, model: null }),
  ),
  executor: withDefault(
    s.object({
      model: withDefault(s.nullish(ModelSchema), () => null),
      maxWorkers: withDefault(s.number({ int: true, ...LIMITS.maxWorkers }), () => 2),
      /** Directory holding the ticket worktrees; empty means `<dataDir>/work`. */
      directory: withDefault(s.string({ trim: true, check: (path) => (path === "" || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? undefined : "an absolute path, or empty") }), () => ""),
      /** Local clone of the repository that worktrees branch from; empty lets the runtime clone it into `<dataDir>/repos`. */
      checkout: withDefault(s.string({ trim: true, check: (path) => (path === "" || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? undefined : "an absolute path, or empty") }), () => ""),
      blockedCommands: withDefault(s.array(CommandNameSchema, { max: 50 }), () => []),
    }),
    () => ({ model: null, maxWorkers: 2, directory: "", checkout: "", blockedCommands: [] }),
  ),
  prompts: withDefault(
    s.object({
      communication: withDefault(s.string({ max: LIMITS.promptSection }), () => ""),
      scope: withDefault(s.string({ max: LIMITS.promptSection }), () => ""),
      delivery: withDefault(s.string({ max: LIMITS.promptSection }), () => ""),
    }),
    () => ({ communication: "", scope: "", delivery: "" }),
  ),
});

export type Settings = Infer<typeof SettingsSchema>;
export type SettingsInput = unknown;

export const settingsJsonSchema = SettingsSchema.json;

/** Validates and completes settings read from disk or submitted by the UI. @throws UserError naming the first invalid field. */
export function parseSettings(raw: unknown): Settings {
  const settings = SettingsSchema.parse(raw ?? {});
  const ids = settings.policy.rules.map((rule) => rule.id);
  if (new Set(ids).size !== ids.length) throw new UserError("invalid", "policy.rules: duplicate rule ids");
  return normalize(settings);
}

export const defaultSettings = (): Settings => parseSettings({});

/** Dedupes allowed-sender lists case-insensitively, keeping the first entry's spelling. */
function normalize(settings: Settings): Settings {
  const unique = (list: Allowed[]): Allowed[] => {
    const seen = new Set<string>();
    return list.filter((entry) => {
      const id = entry.id.toLowerCase();
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  const github = settings.policy.sources.github;
  if (!github) return settings;
  return {
    ...settings,
    policy: { ...settings.policy, sources: { ...settings.policy.sources, github: { ...github, allowed: unique(github.allowed), bots: unique(github.bots) } } },
  };
}

/** The repository the GitHub source watches, or `undefined` while unconfigured. */
export const watchedRepository = (settings: Settings): string | undefined => settings.github.repository || undefined;

/** Why Superagent cannot run yet, as short setup steps; empty when ready. */
export function setupGaps(settings: Settings, input: { hasToken: boolean; login?: string }): string[] {
  const gaps: string[] = [];
  if (!input.hasToken) gaps.push("Connect a GitHub token for the agent account");
  if (!settings.github.repository) gaps.push("Set the GitHub repository to watch (owner/name)");
  const allowed = settings.policy.sources.github?.allowed ?? [];
  if (allowed.length === 0) gaps.push("Add at least one GitHub account that may originate work");
  if (input.login && allowed.some((entry) => entry.id.toLowerCase() === input.login!.toLowerCase())) {
    gaps.push("The agent's own GitHub account must not be on the allowed list; use a dedicated account for the agent");
  }
  return gaps;
}
