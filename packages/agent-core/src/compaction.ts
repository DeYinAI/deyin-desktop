import { completeChat } from "./stream.js";
import { measureContext, priceMessage, priceMessages, type UsageAnchor } from "./context-measure.js";
import { countTokens, truncateToTokens } from "./tokenizer.js";
import type { ProviderApiFormat } from "./transports.js";
import type { AgentMessage, AgentToolCall, WireTool } from "./types.js";
import type { WireOptions } from "./wire.js";

/** Token-aware estimate; falls back gracefully for empty transcripts. */
export function estimateTokens(messages: AgentMessage[]): number {
  return priceMessages(messages);
}

// ---------------------------------------------------------------------------
// Policy constants
//
// All ratios are fractions of the MODEL CONTEXT WINDOW. The previous constants
// were fractions of a derived budget (0.75 × window − schemaTokens), so the
// "50% warning" actually fired near 30% of the window.
// ---------------------------------------------------------------------------

/** Tell the user context is growing. No mutation — the prefix stays cache-stable. */
export const NOTICE_RATIO = 0.5;
/** Prune, remeasure, and fold only if still over. */
export const COMPACT_RATIO = 0.8;
/** High-water mark: fold even when the economics say the payoff is small. */
export const FORCE_RATIO = 0.9;
/**
 * A pass reclaiming less than this fraction of the window does not run at all.
 *
 * This is Anthropic's `clear_at_least` and Reasonix's `foldEconomics`: every
 * mutation of the transcript costs a full prefix-cache re-read, so a pass that
 * saves a few hundred tokens is strictly worse than doing nothing.
 */
export const MIN_RECLAIM_RATIO = 0.1;
/** Verbatim recent history, as a token budget rather than a message count. */
export const TAIL_TOKENS = 16_384;
/**
 * Cap on the verbatim tail as a share of the window.
 *
 * A flat 16k tail assumes a large context window. On a 32k model it would keep
 * half the window verbatim and leave almost nothing foldable, so compaction
 * would find no worthwhile region and let the request overflow instead.
 */
export const TAIL_FRACTION = 0.25;

/** The verbatim tail budget for a given context window. */
export function tailBudgetFor(contextLength: number): number {
  if (contextLength <= 0) return TAIL_TOKENS;
  return Math.max(1, Math.min(TAIL_TOKENS, Math.floor(contextLength * TAIL_FRACTION)));
}
/** Fixed cap for a pruned stale tool result. Fixed, so the pass is idempotent. */
export const STALE_TOOL_RESULT_CAP = 3_000;
/** Errors are dense and rarely re-derivable, so they keep more of themselves. */
export const ERROR_TOOL_RESULT_CAP = 6_000;
/** Tool-call arguments are pruned to this cap (a large `write` payload). */
export const STALE_TOOL_ARGS_CAP = 600;
/** Pin the opening user turn (the task definition) when it is this small. */
export const MAX_PINNED_FIRST_USER_TOKENS = 2_000;
/** Consecutive compaction attempts before auto-compaction gives up. */
export const MAX_CONSECUTIVE_COMPACTS = 2;

const IMPORTANCE_KEEP_THRESHOLD = 4;

const PRUNED_RESULT_NOTE = "\n… [tool result pruned — re-read the source if you need the rest]";
const PRUNED_ARGS_NOTE = "… [arguments pruned]";
/** The note costs tokens too; the cap is the size of the whole replacement. */
const PRUNED_RESULT_NOTE_TOKENS = countTokens(PRUNED_RESULT_NOTE);

/**
 * Score how important a message is to keep under pressure.
 * Higher = keep longer. Errors, recent turns, and system prompts win.
 */
export function scoreMessageImportance(msg: AgentMessage, index: number, total: number): number {
  const recency = total <= 1 ? 1 : index / (total - 1); // 0..1
  let score = recency * 3;

  if (msg.role === "system") return 100;
  if (msg.role === "user") score += 2;
  if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) score += 1;

  const text = msg.content;
  if (/\b(error|exception|failed|denied|traceback|enoent)\b/i.test(text)) score += 3;
  if (msg.role === "tool" && text.startsWith("ERROR:")) score += 3;
  if (msg.role === "tool" && text.length < 200) score += 1; // short results are cheap to keep
  if (msg.role === "user" && text.startsWith(COMPACTION_SUMMARY_OPEN)) score += 4;

  return score;
}

// ---------------------------------------------------------------------------
// Region selection
// ---------------------------------------------------------------------------

/**
 * How many leading messages are pinned and never folded: every leading system
 * message, plus the opening user turn when it is small enough to be worth
 * keeping verbatim. That first turn is the task definition — folding it into a
 * summary of itself is how agents lose the plot on long sessions.
 */
export function pinnedPrefixLen(messages: readonly AgentMessage[]): number {
  let n = 0;
  while (n < messages.length && messages[n]!.role === "system") n += 1;
  const first = messages[n];
  if (first?.role === "user" && priceMessage(first) <= MAX_PINNED_FIRST_USER_TOKENS) n += 1;
  return n;
}

/**
 * True when the transcript can be split immediately before `index` without
 * orphaning a tool result from the assistant `tool_calls` that requested it.
 *
 * Providers reject a `tool_result` whose `tool_use` is missing, so every region
 * boundary has to land here. Note this checks pairing, not turn boundaries: an
 * oversized turn's early closed steps are still foldable.
 */
export function toolPairingBalancedAt(messages: readonly AgentMessage[], index: number): boolean {
  if (index <= 0 || index >= messages.length) return true;
  return messages[index]!.role !== "tool";
}

/** Walk back from `index` to the nearest boundary that does not orphan a tool result. */
function balanceBoundary(messages: readonly AgentMessage[], index: number, floor: number): number {
  let i = Math.min(index, messages.length);
  while (i > floor && !toolPairingBalancedAt(messages, i)) i -= 1;
  return i;
}

/**
 * Index where the verbatim tail begins: walk back from the end accumulating
 * message prices until `budget` is spent, then balance the boundary.
 */
export function tailStart(
  messages: readonly AgentMessage[],
  floor: number,
  budget = TAIL_TOKENS,
): number {
  let spent = 0;
  let i = messages.length;
  while (i > floor) {
    const next = spent + priceMessage(messages[i - 1]!);
    if (next > budget) break;
    spent = next;
    i -= 1;
  }
  return balanceBoundary(messages, i, floor);
}

/** The foldable middle: everything between the pinned prefix and the verbatim tail. */
export interface CompactionRegion {
  start: number;
  end: number;
  tokens: number;
}

export function selectRegion(messages: readonly AgentMessage[], tailBudget = TAIL_TOKENS): CompactionRegion {
  const start = pinnedPrefixLen(messages);
  const end = Math.max(start, tailStart(messages, start, tailBudget));
  let tokens = 0;
  for (let i = start; i < end; i++) tokens += priceMessage(messages[i]!);
  return { start, end, tokens };
}

// ---------------------------------------------------------------------------
// Prune: idempotent, fixed-cap shrinking of stale tool output
// ---------------------------------------------------------------------------

/** One planned replacement. Nothing is mutated until `applyPrune` runs. */
export interface PruneEdit {
  index: number;
  kind: "tool-result" | "tool-args";
  message: AgentMessage;
  before: number;
  after: number;
}

export interface PrunePlan {
  edits: PruneEdit[];
  reclaimedTokens: number;
}

export interface PruneOutcome {
  truncatedToolResults: number;
  truncatedToolArgs: number;
  reclaimedTokens: number;
}

/**
 * Plan a prune pass over the region outside the pinned prefix and verbatim tail.
 *
 * Every oversized tool result is shrunk to a FIXED cap — not "until the
 * transcript fits". That single property is what makes the pass idempotent:
 * running it twice finds nothing left above the cap, so it cannot re-fire on
 * every step the way the old budget-chasing loop did.
 */
export function planPrune(
  messages: readonly AgentMessage[],
  opts: { tailBudget?: number } = {},
): PrunePlan {
  const region = selectRegion(messages, opts.tailBudget ?? TAIL_TOKENS);
  const edits: PruneEdit[] = [];
  let reclaimedTokens = 0;

  for (let i = region.start; i < region.end; i++) {
    const m = messages[i]!;

    if (m.role === "tool") {
      const score = scoreMessageImportance(m, i, messages.length);
      const cap = score >= IMPORTANCE_KEEP_THRESHOLD + 2 ? ERROR_TOOL_RESULT_CAP : STALE_TOOL_RESULT_CAP;
      const before = priceMessage(m);
      if (before <= cap) continue;
      // Truncate to the cap MINUS the note, so the replacement lands at the cap
      // rather than above it — otherwise a result barely over the line would
      // grow instead of shrinking and the pass would never converge.
      const content = `${truncateToTokens(m.content, Math.max(1, cap - PRUNED_RESULT_NOTE_TOKENS))}${PRUNED_RESULT_NOTE}`;
      const next: AgentMessage = { ...m, content };
      const after = priceMessage(next);
      if (after >= before) continue;
      edits.push({ index: i, kind: "tool-result", message: next, before, after });
      reclaimedTokens += before - after;
      continue;
    }

    if (m.role === "assistant" && m.toolCalls?.length) {
      const before = priceMessage(m);
      let changed = false;
      const toolCalls: AgentToolCall[] = m.toolCalls.map((call) => {
        if (call.arguments.length <= STALE_TOOL_ARGS_CAP) return call;
        const patched = truncateArgsJson(call.arguments);
        if (patched === null) return call;
        changed = true;
        return { ...call, arguments: patched };
      });
      if (!changed) continue;
      const next: AgentMessage = { ...m, toolCalls };
      const after = priceMessage(next);
      if (after >= before) continue;
      edits.push({ index: i, kind: "tool-args", message: next, before, after });
      reclaimedTokens += before - after;
    }
  }

  return { edits, reclaimedTokens };
}

/**
 * Apply a plan by REPLACING message objects at their indices.
 *
 * Replacement rather than in-place edit is deliberate: external references to
 * the old message (the session log, the UI's rendered transcript) keep seeing
 * the full-fidelity original, and the per-message token memo invalidates itself
 * because it is keyed on object identity.
 */
export function applyPrune(messages: AgentMessage[], plan: PrunePlan): PruneOutcome {
  const outcome: PruneOutcome = {
    truncatedToolResults: 0,
    truncatedToolArgs: 0,
    reclaimedTokens: plan.reclaimedTokens,
  };
  for (const edit of plan.edits) {
    messages[edit.index] = edit.message;
    if (edit.kind === "tool-result") outcome.truncatedToolResults += 1;
    else outcome.truncatedToolArgs += 1;
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Compaction policy
// ---------------------------------------------------------------------------

export type CompactionTrigger = "pressure" | "context-overflow" | "manual";

export interface CompactionPolicyInput {
  messages: readonly AgentMessage[];
  contextLength: number;
  schemaTokens?: number;
  anchor?: UsageAnchor;
  trigger: CompactionTrigger;
  /** Passes already made without an intervening non-compacting step. */
  consecutiveCompacts?: number;
}

export type CompactionAction =
  | { action: "none"; ratio: number; notice: boolean }
  | { action: "prune"; ratio: number; plan: PrunePlan }
  /** No plan: a fold discards the whole region, so pruning inside it is wasted work. */
  | { action: "fold"; ratio: number; region: CompactionRegion }
  | { action: "exhausted"; ratio: number };

/**
 * Decide what — if anything — to do about current context pressure.
 *
 * Order matters: prune first, remeasure, and only fold if the cheap pass was
 * not enough. A fold costs an extra model call and destroys the recoverable
 * detail of the middle of the conversation; it is the last resort, not the
 * first.
 */
export function decideCompaction(input: CompactionPolicyInput): CompactionAction {
  const measurement = measureContext({
    messages: input.messages,
    contextLength: input.contextLength,
    schemaTokens: input.schemaTokens,
    anchor: input.anchor,
  });
  const ratio = measurement.ratio;
  const overflow = input.trigger === "context-overflow";
  const manual = input.trigger === "manual";

  if (!overflow && !manual && ratio < COMPACT_RATIO) {
    return { action: "none", ratio, notice: ratio >= NOTICE_RATIO };
  }

  // The circuit breaker. When one retained unit is larger than the whole window
  // no amount of compaction helps, and retrying forever is the failure mode in
  // the screenshot that started this work.
  if ((input.consecutiveCompacts ?? 0) >= MAX_CONSECUTIVE_COMPACTS && !manual) {
    return { action: "exhausted", ratio };
  }

  const window = Math.max(1, input.contextLength);
  const minReclaim = Math.floor(window * MIN_RECLAIM_RATIO);
  const tailBudget = tailBudgetFor(input.contextLength);
  const plan = planPrune(input.messages, { tailBudget });

  // Would pruning alone bring us back under the line, and is it worth the
  // cache invalidation? Overflow skips the economics gate: any reduction beats
  // a request the provider will reject outright.
  const afterPrune = measurement.totalTokens - plan.reclaimedTokens;
  const worthIt = plan.reclaimedTokens >= minReclaim || (overflow && plan.reclaimedTokens > 0);
  if (worthIt && (afterPrune / window < COMPACT_RATIO || overflow)) {
    return { action: "prune", ratio, plan };
  }

  // A fold removes the whole region, pruned or not — `planPrune` works over
  // exactly the same span, so its savings are a subset of the region's, not an
  // addition to them.
  const region = selectRegion(input.messages, tailBudget);
  const forced = manual || overflow || ratio >= FORCE_RATIO;
  if (region.end <= region.start || (!forced && region.tokens < minReclaim)) {
    // Nothing worth folding. Take the prune if there was one, else stand down
    // and let the log keep growing — a cache-stable prefix is worth more than a
    // marginal saving.
    if (plan.reclaimedTokens > 0 && (worthIt || forced)) return { action: "prune", ratio, plan };
    return { action: "none", ratio, notice: ratio >= NOTICE_RATIO };
  }

  return { action: "fold", ratio, region };
}

// ---------------------------------------------------------------------------
// Fold: replace the middle with a model-written structured briefing
// ---------------------------------------------------------------------------

export const COMPACTION_SUMMARY_OPEN = "<compaction-summary>";
export const COMPACTION_SUMMARY_CLOSE = "</compaction-summary>";

/**
 * Cap on the briefing itself. A summary that runs long defeats the point, and an
 * uncapped fold can bill for a full-length completion.
 */
export const SUMMARY_OUTPUT_MAX_TOKENS = 8_192;

const SUMMARY_INSTRUCTIONS = [
  "Compact the preceding conversation into a durable resume briefing, so the work can continue in a fresh context window.",
  "Write a dense briefing under exactly these headings, in this order. Keep every heading even if a section is empty (write 'None').",
  "",
  "## Goal",
  "The user's intent and constraints, verbatim where possible. Never paraphrase away a requirement.",
  "## Decisions & rationale",
  "Choices already made and why, so they are not re-litigated.",
  "## Files & code",
  "Concrete facts: paths, signatures, data shapes, and the exact edits already applied.",
  "## Commands & outcomes",
  "Builds, tests and shell commands that were run, and what they returned.",
  "## Errors & fixes",
  "Problems hit and how they were resolved (or that they are still open).",
  "## Pending & next step",
  "What remains, ending with the single most concrete next action.",
  "",
  "Be specific and dense. Plain text under the headings; no preamble, no sign-off.",
  "Do not call any tools. Output only the briefing.",
].join("\n");

export interface FoldResult {
  summary: string;
  /** Messages removed from the surface. The caller's log keeps them. */
  droppedMessages: number;
  reclaimedTokens: number;
}

/**
 * Model-driven fold: replaces `region` with one structured briefing.
 *
 * **The request shape is the point.** The obvious implementation — a fresh
 * system prompt, no tools, and just the region to summarise — shares no prefix
 * with the ordinary request, so the provider re-reads the whole 30–60k-token
 * region cold at full input price, on the blocking path, every single fold.
 *
 * Instead we replay the run's *real* prefix: the same system message, the same
 * tool schemas, and `messages[0 .. region.end)` byte-for-byte, then append one
 * instruction as the only new content. Everything before that instruction is a
 * prefix the provider has already cached from the ordinary requests of this
 * run, so the fold costs roughly a cache read plus the briefing's own output.
 *
 * The caller must therefore pass the run's own `tools`, `wire` and
 * `promptCacheKey`, and must use the run's own model — a different model has a
 * different cache, which is exactly what this is buying.
 *
 * Mutates `messages` in place (splice) because the loop and the desktop host
 * share that array identity, but the messages it removes are untouched objects
 * — the append-only session log still holds every one of them.
 */
export async function foldRegion(opts: {
  apiBaseUrl: string;
  token: string;
  model: string;
  messages: AgentMessage[];
  region: CompactionRegion;
  /** Extra steer for a manual `/compact focus on …`. */
  focus?: string;
  apiFormat?: ProviderApiFormat;
  authHeader?: boolean;
  signal?: AbortSignal;
  /** The run's tool schemas — sent so the cached prefix matches byte for byte. */
  tools?: WireTool[];
  /** The run's wire options. `previousMessageCount` is dropped by the caller. */
  wire?: WireOptions;
  /** The run's prompt cache key, so OpenAI-style routing lands on the same entry. */
  promptCacheKey?: string;
  /** Injection seam for tests and benchmarks; defaults to the real transport. */
  complete?: typeof completeChat;
}): Promise<FoldResult> {
  const { messages, region } = opts;
  const slice = messages.slice(region.start, region.end);
  if (slice.length === 0) return { summary: "", droppedMessages: 0, reclaimedTokens: 0 };

  const focus = opts.focus ? `\n\nPay particular attention to: ${opts.focus}` : "";
  const { content } = await (opts.complete ?? completeChat)({
    apiBaseUrl: opts.apiBaseUrl,
    token: opts.token,
    model: opts.model,
    apiFormat: opts.apiFormat,
    authHeader: opts.authHeader,
    signal: opts.signal,
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
    ...(opts.wire ? { wire: opts.wire } : {}),
    ...(opts.promptCacheKey ? { promptCacheKey: opts.promptCacheKey } : {}),
    maxTokens: SUMMARY_OUTPUT_MAX_TOKENS,
    messages: [
      // The real prefix, unmodified — this is what the provider has cached.
      ...messages.slice(0, region.end),
      // The only new content in the request.
      { role: "user", content: `${SUMMARY_INSTRUCTIONS}${focus}` },
    ],
  });

  const summary = content.trim();
  if (!summary) return { summary: "", droppedMessages: 0, reclaimedTokens: 0 };

  const before = priceMessages(slice);
  const replacement = summaryMessage(summary);
  // A checkpoint must be strictly smaller than what it replaces. A summary that
  // grew the transcript is worse than no fold at all — it costs a model call AND
  // a prefix-cache reset to make the pressure problem worse.
  const after = priceMessage(replacement);
  if (after >= before) return { summary: "", droppedMessages: 0, reclaimedTokens: 0 };

  messages.splice(region.start, slice.length, replacement);
  return { summary, droppedMessages: slice.length, reclaimedTokens: before - after };
}

/** The surface node that stands in for a folded region. */
export function summaryMessage(summary: string): AgentMessage {
  return {
    role: "user",
    content: `${COMPACTION_SUMMARY_OPEN}\nEarlier history was compacted. This briefing replaces it.\n\n${summary}\n${COMPACTION_SUMMARY_CLOSE}`,
  };
}

/**
 * The verbatim tail a manual `/compact` keeps.
 *
 * Deliberately tighter than the automatic tail: the user asked for space back
 * now, so holding 16k of recent history verbatim would routinely leave nothing
 * to fold and make the command look broken.
 */
export const MANUAL_TAIL_TOKENS = 4_096;

/**
 * Manual `/compact`: fold everything foldable and return the new transcript.
 * Does not mutate the caller's array. Returns the input unchanged when there is
 * no safe region to fold, so callers can report that honestly.
 */
export async function compactWithModel(opts: {
  apiBaseUrl: string;
  token: string;
  model: string;
  messages: AgentMessage[];
  focus?: string;
  tailTokens?: number;
  apiFormat?: ProviderApiFormat;
  authHeader?: boolean;
  signal?: AbortSignal;
  /** Pass the session's tools/wire/cache key so a manual fold is cached too. */
  tools?: WireTool[];
  wire?: WireOptions;
  promptCacheKey?: string;
  /** Injection seam for tests and benchmarks; defaults to the real transport. */
  complete?: typeof completeChat;
}): Promise<AgentMessage[]> {
  const messages = [...opts.messages];
  const region = selectRegion(messages, opts.tailTokens ?? MANUAL_TAIL_TOKENS);
  if (region.end <= region.start) return opts.messages;
  const fold = await foldRegion({ ...opts, messages, region });
  return fold.droppedMessages > 0 ? messages : opts.messages;
}

// ---------------------------------------------------------------------------
// Argument truncation
// ---------------------------------------------------------------------------

/**
 * Truncate large string values inside a tool-call's JSON arguments while keeping
 * the object's shape (same keys, same primitive types) so strict providers that
 * validate historical `tool_calls.function.arguments` against the tool's schema
 * still accept the replayed message. Returns null if the arguments are not valid
 * JSON, in which case the caller leaves them untouched.
 */
export function truncateArgsJson(raw: string, max = STALE_TOOL_ARGS_CAP): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const truncated = truncateStringsInPlace(parsed, max);
  return truncated ? JSON.stringify(parsed) : null;
}

function truncateStringsInPlace(value: unknown, max: number): boolean {
  if (typeof value === "string") return false;
  if (Array.isArray(value)) {
    let changed = false;
    for (let i = 0; i < value.length; i++) {
      const item = value[i]!;
      if (typeof item === "string" && item.length > max) {
        value[i] = `${item.slice(0, max)}${PRUNED_ARGS_NOTE}`;
        changed = true;
      } else {
        changed = truncateStringsInPlace(item, max) || changed;
      }
    }
    return changed;
  }
  if (value && typeof value === "object") {
    let changed = false;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === "string" && v.length > max) {
        (value as Record<string, unknown>)[key] = `${v.slice(0, max)}${PRUNED_ARGS_NOTE}`;
        changed = true;
      } else {
        changed = truncateStringsInPlace(v, max) || changed;
      }
    }
    return changed;
  }
  return false;
}
