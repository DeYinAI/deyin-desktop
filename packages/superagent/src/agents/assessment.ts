/**
 * Proactive assessment, done by the orchestrator itself: the schema of its decision, the conversion of a decision into an
 * engine outcome, and the bounded reads (thread window, messages, files) it makes while assessing.
 */
import { UserError } from "../core/errors.js";
import type { Engine } from "../core/engine.js";
import type { State } from "../core/state.js";
import { IM_WORDS, textPage, wordCount } from "../core/text.js";
import type { Outcome, Strength } from "../core/types.js";
import { GithubReader, type ThreadMessage } from "../github/read.js";
import * as s from "../schema.js";
import type { Infer } from "../schema.js";
import type { Settings } from "../settings.js";
import { relatedTickets } from "./cards.js";

export const WorktreeNameSchema = s.string({
  max: 32,
  pattern: /^[a-z]+(?:-[a-z0-9]+){0,3}$/,
  description:
    "Meaningful short English ticket name, e.g. fix-plan-color. Translate Chinese titles into English; no Chinese, pinyin or generic ticket names. 1–4 lowercase words in kebab-case, at most 32 characters.",
});

export const AcknowledgementSchema = s.string({
  trim: true,
  min: 1,
  check: (text) => (wordCount(text) <= IM_WORDS ? undefined : `an acknowledgement has at most ${IM_WORDS} words; write one short sentence`),
});

const RuleAssessmentSchema = s.object({
  rule_id: s.string({ pattern: /^[a-zA-Z0-9_-]{1,80}$/ }),
  matched: s.boolean(),
  reason: s.string({ trim: true, min: 1, max: 500 }),
});

const DirectionSchema = s.describe(
  s.object({
    implementation_requested: s.boolean(),
    target_basis: s.enumeration(["specified", "existing-standard", "undetermined"] as const),
    requires_design_decision: s.boolean(),
    evidence: s.string({ trim: true, min: 1, max: 700 }),
  }),
  "Required for every decision.",
);
export type Direction = Infer<typeof DirectionSchema>;

/** True when the assessment established implementation intent and a settled target with no open design decision. */
export const directionAllowed = (direction: Direction): boolean => direction.implementation_requested && direction.target_basis !== "undetermined" && !direction.requires_design_decision;

export const AssessmentSchema = s.object({
  trigger_id: s.string({ min: 1 }),
  decision: s.enumeration(["accept", "ignore", "unavailable"] as const),
  rule_assessments: s.describe(s.array(RuleAssessmentSchema), "One per enabled rule."),
  direction: DirectionSchema,
  title: s.string({ min: 1, max: 160 }),
  worktree_name: s.optional(WorktreeNameSchema),
  scope: s.string({ max: 1500 }),
  intent_evidence: s.describe(s.nullish(s.string({ trim: true, min: 1, max: 700 })), "For acceptance: the quotes that establish the three facts."),
  acknowledgement: s.describe(s.nullish(AcknowledgementSchema), "For acceptance: one sentence in the source language, posted as a reply to the trigger; omit only when a matched rule asks for silence."),
  reason: s.string({ min: 1, max: 500 }),
});
export type Assessment = Infer<typeof AssessmentSchema>;

/**
 * Validates an assessment against the enabled rules and turns it into an engine outcome. Acceptance needs a settled direction, a
 * matched enabled rule and intent evidence; an inferred candidate is accepted only in `auto` mode, else recorded as would-accept.
 * @throws UserError when rule assessments do not cover every enabled rule exactly once, or an accept omits what it needs.
 */
export function assessmentOutcome(assessment: Assessment, settings: Pick<Settings, "policy" | "eval">, strength: Strength): Outcome {
  const enabled = settings.policy.rules.filter((rule) => rule.enabled);
  const judged = assessment.rule_assessments;
  const ids = new Set(judged.map((item) => item.rule_id));
  if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some((rule) => !ids.has(rule.id))) {
    throw new UserError("invalid", "Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed");
  }
  const matches = judged.filter((item) => item.matched).map(({ rule_id, reason }) => ({ rule_id, reason }));
  const audit: Record<string, unknown> = { matches, rule_assessments: judged, direction: assessment.direction, ...(assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {}) };
  if (assessment.decision !== "accept") return { kind: assessment.decision, reason: assessment.reason, audit };
  if (!directionAllowed(assessment.direction)) return { kind: "ignore", audit, reason: { code: "directionUnsettled" } };
  if (matches.length === 0) return { kind: "ignore", audit, reason: { code: "noRuleMatched" } };
  if (!assessment.intent_evidence) throw new UserError("invalid", "Acceptance requires intent_evidence");
  if (!assessment.worktree_name) throw new UserError("invalid", "Accepted work requires a short English worktree_name");
  const { title, scope, worktree_name: name } = assessment;
  if (strength === "inferred" && settings.eval.mode !== "auto") {
    return { kind: "ignore", audit: { ...audit, would_accept: true, proposal: { title, scope, worktree_name: name } }, reason: { code: "observed", values: { text: assessment.reason } } };
  }
  return {
    kind: "accept", title, scope, reason: assessment.reason, name, rules: matches.map((match) => match.rule_id), audit,
    ...(assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {}),
  };
}

export const EvalReadSchema = s.object({
  trigger_id: s.describe(s.string({ min: 1 }), "Original candidate ID returned by orchestrator_eval; every reference is scoped to this trigger."),
  resource: s.enumeration(["message", "root", "parent", "thread", "file", "directory", "image"] as const),
  path: s.describe(s.optional(s.string()), "Repository-relative path, only for file/directory."),
  message_id: s.describe(s.optional(s.string()), "Only for message: omit for the trigger, or the id of a window message or stub."),
  cursor: s.describe(s.optional(s.string()), "Only for thread: omit on the first page, then the next_cursor of the window or the cursor of next_read. Never a thread or message ID."),
  image_id: s.describe(s.optional(s.string()), "Only for image: an image id the window or a read lists."),
  offset: s.describe(s.optional(s.number({ int: true, min: 0 })), "Text pagination: copy next_offset; keep the other arguments unchanged."),
});
export type EvalRead = Infer<typeof EvalReadSchema>;

function checkRead(read: EvalRead): void {
  if ((read.resource === "file" || read.resource === "directory") !== (read.path !== undefined)) {
    throw new UserError("invalid", "path is required only for file/directory. To read the source/root/parent, use resource=message/root/parent without a path.");
  }
  if (read.message_id !== undefined && read.resource !== "message") throw new UserError("invalid", "message_id is only for message.");
  if (read.cursor !== undefined && read.resource !== "thread") throw new UserError("invalid", 'cursor is only for thread. First page: {resource:"thread"}.');
  if ((read.resource === "image") !== (read.image_id !== undefined)) throw new UserError("invalid", "Images require image_id from a returned read reference.");
}

const FINISHED = "This assessment has finished: it was decided, timed out or restarted";
const EXPLICIT = "This is an explicit request, which is routed instead of assessed: use orchestrator_route with its trigger_id and kind accept, attach, stop or ignore";
const THREAD_PAGE = 20;

interface Loaded { messages: ThreadMessage[]; isPr: boolean; truncated: boolean }
interface Cached { evalId: string; thread?: Loaded; error?: string; loading?: Promise<void> }

export interface AssessorDeps {
  engine: Engine;
  state: State;
  reader: GithubReader;
}

/** Per-evaluation reads the orchestrator makes while assessing; the cache drops when its evaluation finishes. */
export class Assessor {
  private readonly cache = new Map<string, Cached>();
  constructor(private readonly deps: AssessorDeps) {}

  private live(triggerId: string) {
    const candidate = this.deps.engine.candidate(triggerId);
    if (!candidate) throw new UserError("noAssessment", FINISHED);
    for (const [id, cached] of this.cache) if (!this.deps.engine.candidates().some((item) => item.evalId === cached.evalId)) this.cache.delete(id);
    return candidate;
  }

  /** True once `orchestrator_eval` loaded this candidate, which a decision requires. */
  loaded(triggerId: string): boolean {
    const candidate = this.deps.engine.candidate(triggerId);
    return !!candidate && this.cache.get(candidate.evalId)?.evalId === candidate.evalId;
  }

  private async load(evalId: string, number: number, signal: AbortSignal): Promise<Cached> {
    let entry = this.cache.get(evalId);
    if (!entry) {
      entry = { evalId };
      this.cache.set(evalId, entry);
    }
    if (entry.thread || entry.error) return entry;
    entry.loading ??= this.deps.reader.loadThread(number, signal).then(
      (thread) => { entry!.thread = thread; },
      (error: unknown) => { entry!.error = error instanceof Error ? error.message : String(error); },
    );
    await entry.loading;
    return entry;
  }

  /** The candidate's thread window and related tickets; repeated calls reuse the load. */
  async context(triggerId: string, signal: AbortSignal) {
    const candidate = this.live(triggerId);
    if (candidate.strength === "explicit") throw new UserError("notExplicit", EXPLICIT);
    const trigger = candidate.triggers.find((item) => item.id === triggerId) ?? candidate.triggers[0]!;
    const number = Number(trigger.meta.number);
    const entry = Number.isInteger(number) ? await this.load(candidate.evalId, number, signal) : { evalId: candidate.evalId, error: "The trigger is not on an issue or pull request" };
    const batch = candidate.triggers.map((item) => item.id);
    if (!entry.thread) {
      return { trigger_id: triggerId, batch, strength: candidate.strength, note: `No thread context could be loaded (${entry.error ?? "unknown"}); assess the trigger's own text and the batch.`, ...relatedTickets(candidate.tickets) };
    }
    const messageId = GithubReader.messageId(trigger);
    return {
      trigger_id: triggerId,
      batch,
      strength: candidate.strength,
      thread: candidate.thread.key,
      is_pull_request: entry.thread.isPr,
      trigger_message: messageId,
      window: GithubReader.window(entry.thread.messages, messageId),
      ...(entry.thread.truncated ? { truncated: true } : {}),
      ...relatedTickets(candidate.tickets),
    };
  }

  async read(read: EvalRead, signal: AbortSignal): Promise<unknown> {
    checkRead(read);
    const candidate = this.live(read.trigger_id);
    const trigger = candidate.triggers.find((item) => item.id === read.trigger_id) ?? candidate.triggers[0]!;
    const offset = read.offset ?? 0;
    if (read.resource === "file" || read.resource === "directory") return this.deps.reader.repositoryPath(read.path!, read.resource === "directory", offset, signal);
    if (read.resource === "image") throw new UserError("invalid", "This host cannot read images; assess from the text.");
    const number = Number(trigger.meta.number);
    if (!Number.isInteger(number)) throw new UserError("invalid", "The trigger is not on an issue or pull request");
    const entry = await this.load(candidate.evalId, number, signal);
    if (!entry.thread) throw new UserError("invalid", `Thread context is unavailable: ${entry.error ?? "unknown"}`);
    const { messages } = entry.thread;
    const find = (id: string): ThreadMessage => {
      const found = messages.find((item) => item.id === id);
      if (!found) throw new UserError("invalid", `Unknown message ${id}; use an id the window or a thread page listed`);
      return found;
    };
    const full = (message: ThreadMessage) => ({ message_id: message.id, from: message.from, at: message.at, ...(message.url ? { url: message.url } : {}), ...(message.bot ? { bot: true } : {}), ...textPage(`message/${message.id}`, message.text, offset, 4000) });
    switch (read.resource) {
      case "message": return full(find(read.message_id ?? GithubReader.messageId(trigger)));
      case "root": return full(find("issue"));
      case "parent": return full(find(find(GithubReader.messageId(trigger)).replyTo ?? "issue"));
      case "thread": {
        const start = read.cursor === undefined ? 0 : Number(read.cursor);
        if (!Number.isInteger(start) || start < 0) throw new UserError("invalid", "cursor must be the next_cursor a previous page returned");
        const page = messages.slice(start, start + THREAD_PAGE);
        const next = start + THREAD_PAGE < messages.length ? String(start + THREAD_PAGE) : null;
        return { messages: page.map((item) => ({ id: item.id, from: item.from, at: item.at, text: item.text.slice(0, 400), ...(item.text.length > 400 ? { chars: item.text.length } : {}), ...(item.bot ? { bot: true } : {}) })), next_cursor: next };
      }
      default: {
        throw new UserError("invalid", `Unhandled resource ${read.resource}`);
      }
    }
  }
}
