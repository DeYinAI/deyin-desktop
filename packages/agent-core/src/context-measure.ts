/**
 * One authority for "how full is the context window right now".
 *
 * Two properties matter, and the old `estimateTokens(messages)` call sites had
 * neither:
 *
 * 1. **Memoized per message.** Compaction used to call `estimateTokens` over the
 *    whole transcript once per truncation candidate — O(n²) per step on a long
 *    session. Prices are cached per message object; compaction replaces message
 *    objects rather than editing them, so the memo invalidates itself.
 *
 * 2. **Anchored on the provider's own number.** The loop already receives
 *    `usage.promptTokens` from every successful call. That figure includes the
 *    tool schemas, the wire framing and the provider's own tokenizer — all of
 *    which a local heuristic gets wrong. We anchor on it and add a signed delta
 *    for whatever was appended since, falling back to the local estimate only
 *    when no comparable anchor exists.
 *
 * Every compaction threshold reads `measureContext().totalTokens`, so triggers
 * fire on one consistent number instead of drifting per call site.
 */

import { countTokens } from "./tokenizer.js";
import type { AgentMessage } from "./types.js";

/** Per-message price cache. Keyed on identity: a replaced message re-prices. */
const priceCache = new WeakMap<AgentMessage, number>();

/** Overhead the wire framing adds per message, in the tokenizer's units. */
const PER_MESSAGE_OVERHEAD = 4;

/** Where a measurement's baseline came from. */
export type MeasurementBaseline = "usage" | "estimated";

export interface ContextMeasurement {
  /** Non-negative current request pressure in tokens. */
  totalTokens: number;
  /** Fraction of the context window in use (0 when the window is unknown). */
  ratio: number;
  /** Provider-reported anchor, or a purely local estimate. */
  baseline: MeasurementBaseline;
  /** Route-priced total for the transcript alone, excluding tool schemas. */
  surfaceTokens: number;
}

/** A provider-reported anchor from the last successful call on this route. */
export interface UsageAnchor {
  /** `usage.promptTokens` the provider reported. */
  promptTokens: number;
  /** Locally-estimated surface price of the transcript that produced it. */
  surfaceTokens: number;
}

/** Price one message, memoized on the message object. */
export function priceMessage(message: AgentMessage): number {
  const cached = priceCache.get(message);
  if (cached !== undefined) return cached;

  let tokens = countTokens(message.content) + PER_MESSAGE_OVERHEAD;
  if (message.role === "assistant" && message.toolCalls) {
    for (const call of message.toolCalls) {
      tokens += countTokens(call.name) + countTokens(call.arguments) + PER_MESSAGE_OVERHEAD;
    }
  }
  priceCache.set(message, tokens);
  return tokens;
}

/** Sum the memoized price of every message. */
export function priceMessages(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) total += priceMessage(message);
  return total;
}

/**
 * Current context pressure.
 *
 * With an anchor, the answer is `anchor.promptTokens + (surfaceNow - surfaceThen)`:
 * the provider's own count for the transcript it saw, adjusted by the locally
 * priced growth since. Both sides of the delta use the same estimator, so its
 * bias cancels and only the *change* is heuristic.
 */
export function measureContext(opts: {
  messages: readonly AgentMessage[];
  /** Model context window; 0/undefined leaves `ratio` at 0 rather than inventing one. */
  contextLength?: number;
  /** Tool schema tokens, counted when there is no provider anchor to include them. */
  schemaTokens?: number;
  anchor?: UsageAnchor;
}): ContextMeasurement {
  const surfaceTokens = priceMessages(opts.messages);
  const contextLength = Math.max(0, opts.contextLength ?? 0);

  let totalTokens: number;
  let baseline: MeasurementBaseline;
  if (opts.anchor) {
    // The anchor already accounts for schemas and wire framing.
    totalTokens = Math.max(0, opts.anchor.promptTokens + (surfaceTokens - opts.anchor.surfaceTokens));
    baseline = "usage";
  } else {
    totalTokens = surfaceTokens + Math.max(0, opts.schemaTokens ?? 0);
    baseline = "estimated";
  }

  return {
    totalTokens,
    ratio: contextLength > 0 ? totalTokens / contextLength : 0,
    baseline,
    surfaceTokens,
  };
}
