import type { ReasoningEffort } from "@deyin/host-core/shared";
import { createHash } from "crypto";
import {
  comparePrefixShapes,
  computePrefixShape,
  type CacheChangeReason,
} from "./cache/prefix-tracker.js";
import {
  applyPrune,
  decideCompaction,
  foldRegion,
  MAX_CONSECUTIVE_COMPACTS,
  type CompactionRegion,
  type CompactionTrigger,
} from "./compaction.js";
import { priceMessages, type UsageAnchor } from "./context-measure.js";
import {
  estimateContextUsage,
  splitToolSchemaTokens,
  type ContextSnapshot,
  type SystemPromptSections,
} from "./context-usage.js";
import type { EvidenceLedger } from "./evidence/ledger.js";
import { EvidenceLedger as EvidenceLedgerClass, isMutationTool } from "./evidence/ledger.js";
import { blockPrematureCompletion, checkMutationReadiness } from "./evidence/gates.js";
import { LoopGuard, looksFailed, type GuardIntervention, type GuardOutcome } from "./loop-guard.js";
import { OptimizationTracker, type OptimizationMetrics } from "./optimization.js";
import { RawResultStore } from "./raw-results.js";
import { ResultDeduper, snipToolResult } from "./tool-result.js";
import type { ModelRole, PreviousStep, StepRouter } from "./model-routing.js";
import { buildRecallSuffix } from "./recall.js";
import type { PermissionDecision, PermissionEngine, PermissionResolver } from "./permissions.js";
import { streamChatEvents } from "./stream.js";
import type { StreamImage } from "@deyin/host-core";
import { inlineImageDirective } from "./tools/generate-image.js";
import type { ProviderApiFormat } from "./transports.js";
import type { ToolRegistry } from "./tools/registry.js";
import {
  AuthRequiredError,
  type AgentMessage,
  type AgentToolCall,
  type FileChange,
  type MemoryBridge,
  type TodoItem,
  type TokenUsage,
  type ToolContext,
  type ToolShell,
} from "./types.js";
import type { WireOptions } from "./wire.js";

const DEFAULT_MAX_STEPS = 40;

/**
 * Step cap semantics: `undefined` keeps the built-in default; `null`, 0,
 * negative or non-finite values lift the cap entirely (the loop runs until the
 * model stops calling tools); a positive number caps the run there. Unlimited
 * becomes Infinity so the plain `step <= maxSteps` bound works unchanged.
 */
export function normalizeMaxSteps(value: number | null | undefined): number {
 if (value === undefined) return DEFAULT_MAX_STEPS;
 if (value === null || !Number.isFinite(value) || value <= 0) return Number.POSITIVE_INFINITY;
 return Math.floor(value);
}
const DEFAULT_CONTEXT_TOKENS = 128_000;

export type AgentEvent =
  | { type: "step-start"; step: number }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "assistant-message"; message: AgentMessage }
  | { type: "tool-start"; call: AgentToolCall; summary: string; cwd?: string }
  | { type: "tool-delta"; call: AgentToolCall; delta: string }
  | { type: "tool-end"; call: AgentToolCall; result: string; ok: boolean; denied?: boolean; fromCache?: boolean; cwd?: string }
  | { type: "file-change"; change: FileChange }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "usage"; usage: TokenUsage }
  | { type: "context-snapshot"; snapshot: ContextSnapshot }
  | { type: "optimization"; metrics: OptimizationMetrics }
  | {
      type: "compaction";
      kind: "notice" | "prune" | "fold" | "fold-failed" | "exhausted";
      trigger: CompactionTrigger;
      truncatedToolResults: number;
      truncatedToolArgs: number;
      droppedMessages: number;
      reclaimedTokens: number;
      /** Ratio of the context window in use when the pass ran. */
      ratio: number;
      /** The structured briefing, when this was a fold. */
      summary?: string;
    }
  | { type: "evidence-gate"; code: string; message: string; toolName?: string }
  | { type: "loop-guard"; code: GuardIntervention["code"]; message: string; detail: string }
  | { type: "run-summary"; summary: RunSummary }
  | { type: "model-routed"; step: number; role: ModelRole; model: string; providerId?: string }
  | { type: "done"; reason: AgentRunResult["reason"] };

/**
 * What one run actually cost, in the terms we want to drive down: rounds, tool
 * calls, wasted calls, and how much of the prompt the provider served from cache.
 * Emitted once at the end of every run so a workload can be scored.
 */
export interface RunSummary {
  steps: number;
  toolCalls: number;
  /** Calls per tool name, so a single tool dominating a run is visible. */
  callsByTool: Record<string, number>;
  /** Calls the host refused (permission, hook, plan mode, delivery gate). */
  deniedCalls: number;
  /** Calls that errored or returned an ERROR: result. */
  failedCalls: number;
  /** Results replaced with a pointer because they were byte-identical repeats. */
  duplicateResults: number;
  /** Times a loop guard had to redirect the model. */
  loopGuardTrips: number;
  compactionPasses: number;
  /**
   * Paid fold attempts whose summary came back unusable (empty, or not smaller
   * than the region it replaced). Gated retries are free and not counted.
   */
  foldFailures: number;
  promptTokens: number;
  cachedPromptTokens: number;
  /** cachedPromptTokens / promptTokens, 0 when nothing was sent. */
  cacheHitRate: number;
}

export interface AgentRunOptions {
  apiBaseUrl: string;
  /** Returns a fresh access token (auto-refreshed) or null when signed out. */
  getToken: () => Promise<string | null>;
  model: string;
  /** Model context window in tokens; drives compaction. */
  contextLength?: number;
  /** Full transcript including the system prompt. Mutated in place as the run progresses. */
  messages: AgentMessage[];
  tools: ToolRegistry;
  permissions: PermissionEngine;
  /** Called for "ask" tools; headless runs auto-deny unless --yes set skipAll. */
  resolvePermission: PermissionResolver;
  onEvent?: (event: AgentEvent) => void;
  /** Persistence hook: fired for every message appended to the transcript. */
  onMessage?: (message: AgentMessage) => void;
  /** Lifecycle hooks (hooks.json): return { block } to veto a tool call. */
  beforeTool?: (call: AgentToolCall, args: Record<string, unknown>, summary: string) => Promise<{ block?: string } | void>;
  afterTool?: (call: AgentToolCall, result: string, ok: boolean) => Promise<void>;
  /**
   * Optional semantic tool-result cache (from @deyin/optimization-plugin).
   * Return a cached result string to skip execution; return null to execute.
   */
  lookupToolCache?: (call: AgentToolCall, args: Record<string, unknown>) => Promise<string | null>;
  /** Store a successful tool result in the semantic cache. */
  storeToolCache?: (call: AgentToolCall, args: Record<string, unknown>, result: string) => Promise<void>;
  cwd: string;
  thinking?: boolean;
  /** Reasoning effort for models that support it ("low" | "medium" | "high"). */
  effort?: ReasoningEffort;
  /** Provider wire format; defaults to "chat-completions". */
  apiFormat?: ProviderApiFormat;
  /** Anthropic-compatible gateways using Bearer instead of x-api-key. */
  authHeader?: boolean;
  /** Max output tokens; omitted when unset (Anthropic defaults to 32768). */
  maxTokens?: number;
  /**
 * Max loop iterations (request + tool execution rounds) before the run stops
 * with reason "max-steps". `null` runs unlimited — the loop only ends when the
 * model stops calling tools; `undefined` keeps DEFAULT_MAX_STEPS.
 */
maxSteps?: number | null;
  signal?: AbortSignal;
  todos?: TodoItem[];
  /** Optional host-backed persistent shell for the bash tool. */
  shell?: ToolShell;
  /** Extra tool context hooks (interaction, mode changes, skills, etc.). */
  toolContext?: Partial<ToolContext>;
  /** Background-memory bridge: enables automatic recall before the run's user turn. */
  memory?: MemoryBridge;
  /** Wire-level compression + Anthropic cache_control. */
  wire?: WireOptions;
  /** Stable prompt cache key for OpenAI-compatible providers (shared across steps). */
  promptCacheKey?: string;
  /** Structured system-prompt slices for Context Usage category accounting. */
  systemSections?: SystemPromptSections;
  /** Delivery mode: enforce evidence gates (todos + acceptance criteria + sign-offs). */
  evidenceGatesEnabled?: boolean;
  /** Delivery mode: ledger recording mutations/verifications (created by the host when omitted). */
  evidenceLedger?: EvidenceLedger;
  /**
   * Per-step model routing. When set, the loop asks the router which model to
   * use before every request, so plan/implement/ask/tool phases can run on
   * different models and a mid-run `switch_mode` re-routes immediately.
   * Omit it (the default) and the run uses `model` throughout.
   */
  router?: StepRouter;
  /**
   * The selected model declares image output in the catalog (Gemini flash-image,
   * an image tool on the Responses API). Asks the provider for pictures and lets
   * the loop store whatever the model draws.
   */
  imageOutput?: boolean;
}

export interface AgentRunResult {
  reason: "completed" | "max-steps" | "aborted";
  finalText: string;
  usage: TokenUsage;
  steps: number;
  optimization?: OptimizationMetrics;
  summary?: RunSummary;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * Does this provider error mean "the prompt does not fit"?
 *
 * Every provider words it differently and none of them use a distinct status
 * code, so this matches on the message. A false negative just surfaces the
 * error to the user, which is the same behaviour as before.
 */
export function isContextOverflowError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!message) return false;
  return /context[_ ]length|context window|maximum context|prompt is too long|too many tokens|input length and .*max_tokens|reduce the length of the messages/i.test(
    message,
  );
}

/**
 * The agentic loop: request a completion, surface text/reasoning deltas, execute any
 * requested tools behind the permission engine, append results, and repeat until the
 * model stops calling tools or the step cap is reached.
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const emit = opts.onEvent ?? (() => undefined);
  const maxSteps = normalizeMaxSteps(opts.maxSteps);
  const contextTokens = opts.contextLength ?? DEFAULT_CONTEXT_TOKENS;

  /**
   * The wire tool list, with outright-denied tools removed.
   *
   * Plan/ask/read-only mode is a *permission* rule set, so the model used to see
   * `edit`, `write`, `delete`, `bash`, every git tool and every browser tool,
   * call them, and get a denial string back. Each denial is a wasted round trip
   * that also re-sends the whole transcript. Asking the run's own permission
   * engine which tools it would refuse keeps the wire list and the permissions
   * from ever disagreeing — there is no second allowlist to maintain.
   *
   * Recomputed per step (memoised on the denied set) because `switch_mode` can
   * reconfigure the engine mid-run: leaving plan mode has to hand the write
   * tools back.
   */
  type WireToolSet = {
    signature: string;
    tools: ReturnType<ToolRegistry["toWire"]>;
    split: ReturnType<typeof splitToolSchemaTokens>;
    schemaTokens: number;
  };
  let cachedWire: WireToolSet | undefined;
  const wireTools = (): WireToolSet => {
    const allowed = opts.tools.list().filter((t) => opts.permissions.actionFor(t) !== "deny");
    const signature = allowed
      .map((t) => t.name)
      .sort()
      .join("\u0000");
    if (cachedWire?.signature !== signature) {
      const tools = opts.tools.filtered(allowed.map((t) => t.name)).toWire();
      const split = splitToolSchemaTokens(tools);
      cachedWire = { signature, tools, split, schemaTokens: split.tools + split.mcp + split.subagents };
    }
    return cachedWire;
  };
  let wireSet = wireTools();
  let toolSchemas = wireSet.tools;
  let schemaTokens = wireSet.schemaTokens;
  /** Compression measured by the last request that actually went out. */
  let lastCompression: { originalTokens: number; compressedTokens: number } | undefined;
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 };
  const todos = opts.todos ?? [];
  const tracker = new OptimizationTracker();
  const promptCacheKey = opts.promptCacheKey ?? `deyin-agent:${opts.model}:${opts.cwd}`;
  // Stable across role-routed model switches: provider-side prefix caches key on
  // the byte prefix (system+tools+history), not the model id, so appending a
  // model suffix only fragmented caches without any matching benefit.
  const cacheKeyFor = (_model: string): string => promptCacheKey;
  const evidenceGates = opts.evidenceGatesEnabled === true;
  const ledger = opts.evidenceLedger ?? (evidenceGates ? new EvidenceLedgerClass() : undefined);
  const guard = new LoopGuard();
  const deduper = new ResultDeduper();
  /** Phase-0 accounting: what this run cost, in the terms we want to reduce. */
  const counters = {
    toolCalls: 0,
    callsByTool: {} as Record<string, number>,
    deniedCalls: 0,
    failedCalls: 0,
    loopGuardTrips: 0,
    compactionPasses: 0,
    foldFailures: 0,
  };

  const ctx: ToolContext = {
    cwd: opts.cwd,
    signal: opts.signal,
    todos,
    onTodosChanged: (t) => emit({ type: "todos", todos: [...t] }),
    onFileChanged: (change) => emit({ type: "file-change", change }),
    shell: opts.shell,
    messages: opts.messages,
    evidenceLedger: ledger,
    ...opts.toolContext,
  };
  // Raw (pre-snip) tool results: read_session_context pages them back by the
  // tool_call_id the snip marker names. A host-supplied store wins so a
  // long-lived host can retain more than one run's worth.
  const rawResults = ctx.rawResults ?? new RawResultStore();
  ctx.rawResults = rawResults;

  const append = (message: AgentMessage): void => {
    opts.messages.push(message);
    opts.onMessage?.(message);
  };

  // Automatic memory recall: append a bounded, low-authority suffix to the run's
  // user turn (the transcript's last message). The suffix lives only in this
  // run's in-memory transcript — it is never persisted or injected elsewhere.
  // Idempotent: a message that already carries a recall suffix is left alone.
  if (opts.memory) {
    const last = opts.messages.at(-1);
    if (last && last.role === "user" && !last.content.includes("<recall>")) {
      const suffix = buildRecallSuffix(opts.memory, last.content);
      if (suffix) last.content = `${last.content}\n\n${suffix}`;
    }
  }

  let finalText = "";
  /** What the last step produced; drives the cheap `tool` role (see roleForStep). */
  let previousStep: PreviousStep | undefined;
  /** Model used by the previous step, so `model-routed` only fires on a change. */
  let previousModel = "";
  /**
   * The model whose prefix cache currently holds this transcript — i.e. the one
   * the most recent requests went to. A fold must replay against that model or
   * the whole point of the cache-aligned request shape is lost.
   */
  let foldModel = opts.model;
  /** Prefix shape of the previous request; drives per-turn cache diagnostics. */
  let previousPrefixShape: ReturnType<typeof computePrefixShape> | undefined;
  /** Bumped when compaction mutates the transcript prefix (invalidates provider cache). */
  let logRewriteVersion = 0;
  /**
   * Provider-visible rewrites since the last diagnostics snapshot. Drained on
   * read: only a rewrite the provider actually saw may be blamed for a miss.
   */
  let pendingRewriteReasons: CacheChangeReason[] = [];

  // --- Compaction state -----------------------------------------------------
  /**
   * The provider's own prompt-token count from the last successful call, paired
   * with what our estimator thought the same transcript was worth. Every
   * threshold is measured against `anchor.promptTokens + (now - then)`, so the
   * estimator's bias cancels and only the growth since is heuristic.
   */
  let usageAnchor: UsageAnchor | undefined;
  /** Compaction passes with no successful non-compacting step in between. */
  let consecutiveCompacts = 0;
  /** The pressure notice is shown once per crossing, not once per step. */
  let noticeShown = false;
  /**
   * Fingerprint of the last fold view whose summary came back unusable. A
   * byte-identical retry would pay the same model call for the same nothing, so
   * it is not made (Reasonix calls this the stuck-input receipt).
   */
  let failedFoldView: string | undefined;
  /**
   * Paid-but-failed folds this run; one is the budget. A summarizer that cannot
   * shrink this transcript will not do better two steps later, and every retry
   * is a full-price model call. Overflow and manual compaction bypass.
   */
  let failedFolds = 0;
  /** Report a fold failure once per run, not once per gated attempt. */
  let foldFailureReported = false;
  /** Provider-confirmed overflow replays, bounded so a retry cannot spin. */
  let overflowRetries = 0;
  /**
   * Messages carried by the previous request. The wire layer marks a rolling
   * cache breakpoint there so Anthropic's 20-position lookback always finds an
   * entry a prior request actually wrote, however much this turn appended.
   */
  let previousMessageCount: number | undefined;

  /**
   * The fold deliberately runs on the run's OWN model, not a cheap one.
   *
   * `foldRegion` replays this run's real prefix so the summarisation request
   * hits the provider's KV cache. A cheaper model has a different cache, so
   * routing the fold away would trade ~90% off the input price of a 30–60k-token
   * region for a discount on ~1k output tokens. Input dominates by more than an
   * order of magnitude, so cache alignment wins and the routing is gone.
   */

  /**
   * Consider compaction. Returns true when the surface actually changed.
   *
   * This is the ONLY place the transcript is rewritten. It runs at turn end, at
   * `COMPACT_RATIO` inside a long multi-step turn, and reactively when a
   * provider rejects the request as too long — never unconditionally per step,
   * which is what made the old implementation re-fire on every iteration and
   * invalidate the prefix cache with it.
   */
  const maybeCompact = async (trigger: CompactionTrigger, windowTokens: number): Promise<boolean> => {
    const decision = decideCompaction({
      messages: opts.messages,
      contextLength: windowTokens,
      schemaTokens,
      anchor: usageAnchor,
      trigger,
      consecutiveCompacts,
    });

    const report = (
      kind: "notice" | "prune" | "fold" | "fold-failed" | "exhausted",
      fields: { truncatedToolResults?: number; truncatedToolArgs?: number; droppedMessages?: number; reclaimedTokens?: number; summary?: string } = {},
    ): void => {
      emit({
        type: "compaction",
        kind,
        trigger,
        ratio: decision.ratio,
        truncatedToolResults: fields.truncatedToolResults ?? 0,
        truncatedToolArgs: fields.truncatedToolArgs ?? 0,
        droppedMessages: fields.droppedMessages ?? 0,
        reclaimedTokens: fields.reclaimedTokens ?? 0,
        ...(fields.summary ? { summary: fields.summary } : {}),
      });
    };

    if (decision.action === "none") {
      // Re-arm once pressure drops back below the line so a later crossing is
      // still announced, but never repeat the notice while it stays above.
      if (!decision.notice) noticeShown = false;
      else if (!noticeShown) {
        noticeShown = true;
        report("notice");
      }
      return false;
    }

    if (decision.action === "exhausted") {
      report("exhausted");
      return false;
    }

    // Prune is the cheap pass and runs alone; a fold discards the same region
    // wholesale, so pruning inside it first would be wasted work.
    const pruned =
      decision.action === "prune"
        ? applyPrune(opts.messages, decision.plan)
        : { truncatedToolResults: 0, truncatedToolArgs: 0, reclaimedTokens: 0 };
    let droppedMessages = 0;
    let reclaimedTokens = pruned.reclaimedTokens;
    let summary: string | undefined;

    if (decision.action === "fold") {
      const token = await opts.getToken();
      if (token === null || token === undefined) throw new AuthRequiredError();
      // Receipt gate: a fold that already failed on this view (or failed at all
      // this run) is skipped until something forces it — a manual /compact or a
      // provider-confirmed overflow, both of which are worth another try.
      const viewHash = foldViewHash(opts.messages, decision.region);
      const bypass = trigger === "manual" || trigger === "context-overflow";
      if (!bypass && (failedFolds >= 1 || failedFoldView === viewHash)) {
        if (!foldFailureReported) {
          foldFailureReported = true;
          report("fold-failed");
        }
        return false;
      }
      // Same endpoint, same model, same tools, same cache key as the ordinary
      // request — that identity is what makes the replayed prefix a cache hit.
      // `previousMessageCount` is dropped: it indexes the ordinary request's
      // message array, which is not the one the fold sends.
      const foldWire = opts.wire
        ? { ...opts.wire, model: foldModel, previousMessageCount: undefined }
        : undefined;
      const fold = await foldRegion({
        apiBaseUrl: opts.apiBaseUrl,
        token,
        model: foldModel,
        apiFormat: opts.apiFormat,
        authHeader: opts.authHeader,
        messages: opts.messages,
        region: decision.region,
        signal: opts.signal,
        tools: toolSchemas,
        ...(foldWire ? { wire: foldWire } : {}),
        promptCacheKey,
      });
      droppedMessages = fold.droppedMessages;
      reclaimedTokens += fold.reclaimedTokens;
      summary = fold.summary || undefined;
      if (droppedMessages === 0) {
        // The summarization was paid for and came back unusable. Keep the
        // receipt so the same view is never paid for twice, and spend the
        // run's one failure budget.
        failedFoldView = viewHash;
        failedFolds += 1;
        counters.foldFailures += 1;
        if (!foldFailureReported) {
          foldFailureReported = true;
          report("fold-failed");
        }
        return false;
      }
      failedFoldView = undefined;
      failedFolds = 0;
      foldFailureReported = false;
    }

    const changed = reclaimedTokens > 0 || droppedMessages > 0 || pruned.truncatedToolResults > 0 || pruned.truncatedToolArgs > 0;
    if (!changed) return false;

    // The surface moved, so the anchor no longer describes this transcript, the
    // provider's cached prefix is gone from here on, and the recorded rolling
    // breakpoint position no longer names the same content.
    usageAnchor = undefined;
    previousMessageCount = undefined;
    logRewriteVersion += 1;
    pendingRewriteReasons.push(
      trigger === "context-overflow" ? "overflow" : decision.action === "fold" ? "fold" : "prune",
    );
    consecutiveCompacts += 1;
    counters.compactionPasses += 1;
    noticeShown = false;
    report(decision.action === "fold" ? "fold" : "prune", {
      truncatedToolResults: pruned.truncatedToolResults,
      truncatedToolArgs: pruned.truncatedToolArgs,
      droppedMessages,
      reclaimedTokens,
      summary,
    });
    return true;
  };

  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal?.aborted) return finish("aborted", step - 1);

    // Resolve this step's model before compaction: the window we compact to
    // must be the window of the model that is about to see the transcript.
    const routed = opts.router?.({
      step,
      mode: typeof ctx.sessionMeta?.mode === "string" ? ctx.sessionMeta.mode : undefined,
      previous: previousStep,
    });
    const stepModel = routed?.model ?? opts.model;
    const stepWindow = routed?.contextLength ?? contextTokens;
    const stepWire = opts.wire ? { ...opts.wire, model: stepModel, previousMessageCount } : undefined;
    if (routed && stepModel !== previousModel) {
      emit({ type: "model-routed", step, role: routed.role, model: stepModel, providerId: routed.providerId });
    }
    previousModel = stepModel;
    foldModel = stepModel;

    // A mid-run `switch_mode` reconfigures the permission engine, which changes
    // which tools are visible. Re-resolve before measuring or sending.
    wireSet = wireTools();
    toolSchemas = wireSet.tools;
    schemaTokens = wireSet.schemaTokens;

    // Mid-turn pressure only. A long multi-step turn can outgrow the window on
    // its own, but below COMPACT_RATIO this is a no-op and the prefix is left
    // byte-identical so the provider cache keeps hitting.
    await maybeCompact("pressure", stepWindow);

    // Post-compaction / pre-request: the window the model actually sees this step.
    // Never invent a contextLength for the UI — compaction alone uses DEFAULT_CONTEXT_TOKENS.
    emit({
      type: "context-snapshot",
      snapshot: estimateContextUsage({
        contextLength: routed?.contextLength ?? opts.contextLength ?? 0,
        messages: opts.messages,
        systemSections: opts.systemSections,
        tools: toolSchemas,
        schemaSplit: wireSet.split,
        // Reported by the request that actually went out, rather than measured
        // by compressing the whole transcript a second time to fill one line.
        ...(lastCompression ? { compression: lastCompression } : {}),
      }),
    });

    const token = await (routed?.getToken ?? opts.getToken)();
    // Empty string is valid: local providers (Ollama) need no key.
    if (token === null || token === undefined) throw new AuthRequiredError();

    emit({ type: "step-start", step });

    let content = "";
    let reasoning = "";
    let toolCalls: AgentToolCall[] = [];
    let streamImages: StreamImage[] = [];
    // Priced with the same estimator the anchor delta uses, and captured before
    // the reply is appended, so `usageAnchor` describes exactly this request.
    const surfaceAtRequest = priceMessages(opts.messages);
    const sentMessageCount = opts.messages.length;
    try {
      for await (const event of streamChatEvents({
        apiBaseUrl: routed?.apiBaseUrl ?? opts.apiBaseUrl,
        token,
        model: stepModel,
        messages: opts.messages,
        tools: toolSchemas,
        thinking: opts.thinking,
        effort: opts.effort,
        apiFormat: routed?.apiFormat ?? opts.apiFormat,
        authHeader: routed?.authHeader ?? opts.authHeader,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        wire: stepWire,
        promptCacheKey: cacheKeyFor(stepModel),
        promptCacheOptions: opts.wire?.enablePromptCaching === false ? undefined : { mode: "implicit" },
        imageOutput: opts.imageOutput,
      })) {
        if (event.type === "text") {
          emit({ type: "text-delta", delta: event.delta });
        } else if (event.type === "reasoning") {
          emit({ type: "reasoning-delta", delta: event.delta });
        } else {
          content = event.content;
          reasoning = event.reasoning;
          toolCalls = event.toolCalls;
          streamImages = event.images ?? [];
          if (event.usage) {
            usage.promptTokens += event.usage.promptTokens;
            usage.completionTokens += event.usage.completionTokens;
            usage.totalTokens += event.usage.totalTokens;
            if (event.usage.cachedPromptTokens) {
              usage.cachedPromptTokens = (usage.cachedPromptTokens ?? 0) + event.usage.cachedPromptTokens;
              tracker.recordCachedPromptTokens(event.usage.cachedPromptTokens);
            }
            emit({ type: "usage", usage: { ...usage } });
            // Anchor future pressure measurements on the provider's own count.
            if (event.usage.promptTokens > 0) {
              usageAnchor = { promptTokens: event.usage.promptTokens, surfaceTokens: surfaceAtRequest };
            }
          }
          // Prefix-cache diagnostics: attribute hit/miss tokens to system/tools/log_rewrite
          // churn so the UI and telemetry reflect real provider cache behaviour.
          const shape = computePrefixShape(
            opts.messages.find((m) => m.role === "system"),
            toolSchemas,
            logRewriteVersion,
            schemaTokens,
          );
          const cached = event.usage?.cachedPromptTokens ?? 0;
          const prompt = event.usage?.promptTokens ?? 0;
          const diag = comparePrefixShapes(
            previousPrefixShape,
            shape,
            cached,
            Math.max(0, prompt - cached),
            pendingRewriteReasons,
          );
          pendingRewriteReasons = [];
          previousPrefixShape = shape;
          tracker.recordPrefixShape(shape, diag);
          if (event.compression) {
            tracker.recordCompression(event.compression.originalTokens, event.compression.compressedTokens);
            lastCompression = {
              originalTokens: event.compression.originalTokens,
              compressedTokens: event.compression.compressedTokens,
            };
          }
          // Single optimization emit per done event (avoids duplicate IPC for usage + compression).
          emit({ type: "optimization", metrics: tracker.get() });
        }
      }
    } catch (err) {
      if (opts.signal?.aborted || isAbortError(err)) return finish("aborted", step);
      // The provider is the authority on whether the prompt fits. When it says
      // no, compact and replay the same step — but only if compaction actually
      // moved the surface, so an oversized single message fails loudly instead
      // of spinning. The circuit breaker in decideCompaction bounds this too.
      if (isContextOverflowError(err) && overflowRetries < MAX_CONSECUTIVE_COMPACTS) {
        overflowRetries += 1;
        if (await maybeCompact("context-overflow", stepWindow)) {
          step -= 1; // replay this step against the compacted surface
          continue;
        }
      }
      throw err;
    }

    // A step that completed without needing compaction re-arms the breaker.
    consecutiveCompacts = 0;
    previousMessageCount = sentMessageCount;

    // A model that draws its own pictures returns them beside the text. Store
    // each one and append its embed directive so the reply renders the image —
    // exactly what generate_image does for the images endpoint.
    if (streamImages.length > 0) {
      const embedded = await storeStreamImages(streamImages, ctx);
      if (embedded.length > 0) {
        const block = (content.endsWith("\n") || content.length === 0 ? "" : "\n\n") + embedded.join("\n");
        content += block;
        emit({ type: "text-delta", delta: block });
      }
    }

    const assistant: AgentMessage = {
      role: "assistant",
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    append(assistant);
    emit({ type: "assistant-message", message: assistant });
    if (content) finalText = content;

    // Record what this step did so the next one can be recognised as pure
    // read-only churn. Unknown tools count as non-read: never route a step that
    // followed something we cannot classify to the cheap model.
    const toolNames = toolCalls.map((call) => call.name);
    previousStep = {
      hadProse: content.trim().length > 0,
      toolNames,
      allRead: toolNames.every((name) => opts.tools.get(name)?.tier === "read"),
    };

    if (toolCalls.length === 0) {
      // Delivery mode: reject premature "all done" claims until every step is
      // signed off. Append the gate message as a user turn and keep the loop going.
      if (evidenceGates && ledger) {
        const gate = blockPrematureCompletion(content, todos, ledger);
        if (!gate.ok) {
          emit({ type: "evidence-gate", code: gate.code, message: gate.message });
          append({ role: "user", content: `Delivery gate (${gate.code}): ${gate.message} Continue working the steps; do not repeat this summary.` });
          continue;
        }
      }
      // Turn end: the natural cache-reset boundary. Compacting here rather than
      // mid-loop means the whole turn ran against one stable prefix, and the
      // next turn starts from a transcript that already fits.
      await maybeCompact("pressure", stepWindow);
      return finish("completed", step);
    }

    // Run same-step tool calls concurrently (Cursor-style). Results are appended
    // in the original tool_calls order so the transcript stays valid for providers
    // that require matching order.
    if (opts.signal?.aborted) {
      for (const call of toolCalls) {
        append(toolResult(call, "Aborted by the user before execution.", deduper, opts, rawResults));
      }
    } else {
      const outcomes = await executeSameStepCalls(toolCalls, opts, ctx, emit, tracker, ledger, guard);
      for (let i = 0; i < toolCalls.length; i++) {
        const outcome = outcomes[i]!;
        counters.toolCalls += 1;
        counters.callsByTool[outcome.toolName] = (counters.callsByTool[outcome.toolName] ?? 0) + 1;
        if (outcome.denied) counters.deniedCalls += 1;
        else if (!outcome.ok) counters.failedCalls += 1;
        append(toolResult(toolCalls[i]!, outcome.result, deduper, opts, rawResults));
      }

      // The guards run after the whole batch, so a turn that mixed a success
      // with a failure is correctly read as progress.
      const intervention = guard.observe(outcomes);
      if (intervention) {
        counters.loopGuardTrips += 1;
        emit({
          type: "loop-guard",
          code: intervention.code,
          message: intervention.message,
          detail: intervention.detail,
        });
        // A user turn rather than a tool result: the redirect is about the run,
        // not about any single call, and tool results must stay paired with the
        // tool_calls that requested them.
        append({ role: "user", content: intervention.message });
      }
      emit({ type: "optimization", metrics: tracker.get() });
    }
  }

  await maybeCompact("pressure", contextTokens);
  return finish("max-steps", maxSteps);

  function finish(reason: AgentRunResult["reason"], steps: number): AgentRunResult {
    const cached = usage.cachedPromptTokens ?? 0;
    const summary: RunSummary = {
      steps,
      toolCalls: counters.toolCalls,
      callsByTool: { ...counters.callsByTool },
      deniedCalls: counters.deniedCalls,
      failedCalls: counters.failedCalls,
      duplicateResults: deduper.elidedCount,
      loopGuardTrips: counters.loopGuardTrips,
      compactionPasses: counters.compactionPasses,
      foldFailures: counters.foldFailures,
      promptTokens: usage.promptTokens,
      cachedPromptTokens: cached,
      cacheHitRate: usage.promptTokens > 0 ? cached / usage.promptTokens : 0,
    };
    emit({ type: "run-summary", summary });
    emit({ type: "done", reason });
    return { reason, finalText, usage, steps, optimization: tracker.get(), summary };
  }
}

/**
 * Run one step's tool calls, concurrent where that is safe.
 *
 * Read-tier tools have no side effects, so a consecutive run of them executes
 * together. Everything else runs exclusively, in the order the model asked for
 * it: two `edit` calls against the same file are a read-modify-write race that
 * silently drops one of the edits, and a shared todo list or evidence ledger has
 * the same problem. Unknown tools count as exclusive — we cannot classify them.
 *
 * Results come back in `toolCalls` order either way, which is what providers
 * require of the appended tool messages.
 */
async function executeSameStepCalls(
  toolCalls: AgentToolCall[],
  opts: AgentRunOptions,
  ctx: ToolContext,
  emit: (event: AgentEvent) => void,
  tracker: OptimizationTracker,
  ledger: EvidenceLedger | undefined,
  guard: LoopGuard,
): Promise<GuardOutcome[]> {
  const outcomes = new Array<GuardOutcome>(toolCalls.length);
  const isRead = (call: AgentToolCall): boolean => opts.tools.get(call.name)?.tier === "read";
  let i = 0;
  while (i < toolCalls.length) {
    if (!isRead(toolCalls[i]!)) {
      outcomes[i] = await executeCall(toolCalls[i]!, opts, ctx, emit, tracker, ledger, guard);
      i += 1;
      continue;
    }
    let end = i;
    while (end < toolCalls.length && isRead(toolCalls[end]!)) end += 1;
    const batch = toolCalls.slice(i, end);
    const results = await Promise.all(
      batch.map((call) => executeCall(call, opts, ctx, emit, tracker, ledger, guard)),
    );
    for (let k = 0; k < results.length; k++) outcomes[i + k] = results[k]!;
    i = end;
  }
  return outcomes;
}

/**
 * Append one tool result, deduplicated against this run and snipped to the hard
 * cap keeping both ends. When the snip actually trimmed, the raw bytes are
 * retained in `rawResults` so `read_session_context` can page the missing
 * middle back by the tool_call_id the marker names.
 */
function toolResult(
  call: AgentToolCall,
  content: string,
  deduper: ResultDeduper,
  opts: AgentRunOptions,
  rawResults: RawResultStore,
): AgentMessage {
  const duplicate = deduper.check(content, call.id);
  if (duplicate !== null) {
    return { role: "tool", toolCallId: call.id, toolName: call.name, content: duplicate };
  }
  const wire = snipToolResult(content, call.name, call.id, opts.tools.get(call.name)?.snipHint);
  if (wire !== content) rawResults.record(call.id, call.name, content);
  return { role: "tool", toolCallId: call.id, toolName: call.name, content: wire };
}

/** Fingerprint of the exact region a fold would summarise (the paid view). */
function foldViewHash(messages: readonly AgentMessage[], region: CompactionRegion): string {
  const hash = createHash("sha256");
  for (let i = region.start; i < region.end; i++) {
    const m = messages[i]!;
    hash.update(`${m.role}\u0000${m.content}\u0000${m.role === "tool" ? m.toolCallId : ""}\u0001`);
  }
  return hash.digest("hex");
}

async function executeCall(
  call: AgentToolCall,
  opts: AgentRunOptions,
  ctx: ToolContext,
  emit: (event: AgentEvent) => void,
  tracker: OptimizationTracker,
  ledger: EvidenceLedger | undefined,
  guard: LoopGuard,
): Promise<GuardOutcome> {
  const argsKey = call.arguments.trim();
  const out = (result: string, flags: { ok: boolean; denied?: boolean }): GuardOutcome => ({
    toolName: call.name,
    result,
    ok: flags.ok,
    denied: flags.denied === true,
    argsKey,
  });

  const tool = opts.tools.get(call.name);
  if (!tool) {
    emit({ type: "tool-start", call, summary: call.name });
    const msg = `ERROR: unknown tool "${call.name}". Available tools: ${opts.tools.names().join(", ")}.`;
    emit({ type: "tool-end", call, result: msg, ok: false });
    return out(msg, { ok: false });
  }

  let args: Record<string, unknown>;
  try {
    args = call.arguments.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
  } catch {
    emit({ type: "tool-start", call, summary: call.name });
    const msg = "ERROR: tool arguments were not valid JSON. Emit a single well-formed JSON object.";
    emit({ type: "tool-end", call, result: msg, ok: false });
    return out(msg, { ok: false });
  }

  const summary = safeSummary(tool.summarize, args, call.name);
  const cwd = safeMeta(tool.meta, args, ctx);
  emit({ type: "tool-start", call, summary, cwd });

  // Loop guard: refuse a write-like call that has already succeeded identically
  // several times in this run. Cheaper than executing the no-op and far cheaper
  // than letting the model discover it is looping.
  const repeat = guard.precheck(call.name, argsKey, tool.tier);
  if (repeat) {
    emit({ type: "tool-end", call, result: repeat, ok: false, denied: true });
    return out(repeat, { ok: false, denied: true });
  }

  // Delivery mode: block mutations until todos carry acceptance criteria.
  if (opts.evidenceGatesEnabled && ledger && isMutationTool(call.name) && tool.tier !== "read") {
    const gate = checkMutationReadiness(ctx.todos);
    if (!gate.ok) {
      emit({ type: "evidence-gate", code: gate.code, message: gate.message, toolName: call.name });
      const msg = `ERROR: delivery gate (${gate.code}): ${gate.message}`;
      emit({ type: "tool-end", call, result: msg, ok: false, denied: true });
      return out(msg, { ok: false, denied: true });
    }
  }

  // Lifecycle hooks run before the permission prompt so a blocking hook never
  // bothers the user with a dialog for an action that would be vetoed anyway.
  if (opts.beforeTool) {
    try {
      const hookResult = await opts.beforeTool(call, args, summary);
      if (hookResult?.block) {
        const msg = `Blocked by hook: ${hookResult.block}`;
        emit({ type: "tool-end", call, result: msg, ok: false, denied: true });
        return out(msg, { ok: false, denied: true });
      }
    } catch {
      // Hook engine failures fail open by design.
    }
  }

  let action = opts.permissions.actionFor(tool);
  if (action === "ask") {
    let decision: PermissionDecision;
    try {
      decision = await opts.resolvePermission({ toolName: tool.name, tier: tool.tier, args, summary });
    } catch {
      // A crashed/rejected dialog must not tear down the run with a dangling
      // assistant tool_calls message in the transcript — treat it as a denial.
      decision = "deny";
    }
    if (decision === "allow-always") {
      opts.permissions.grantForSession(tool.name);
      action = "allow";
    } else {
      action = decision === "allow" ? "allow" : "deny";
    }
  }
  if (action === "deny") {
    const msg = "Denied: the user rejected this tool call. Do not retry it; adjust your approach or ask the user.";
    emit({ type: "tool-end", call, result: msg, ok: false, denied: true });
    ledger?.observeToolCall(call.name, args, false);
    return out(msg, { ok: false, denied: true });
  }

  try {
    if (opts.lookupToolCache) {
      const cached = await opts.lookupToolCache(call, args);
      if (cached !== null) {
        tracker.recordToolCache(true);
        emit({ type: "tool-end", call, result: cached, ok: true, fromCache: true });
        if (opts.afterTool) await opts.afterTool(call, cached, true).catch(() => undefined);
        return out(cached, { ok: true });
      }
      tracker.recordToolCache(false);
    }

    // Bind onOutput per call so streaming tool output carries the right call id.
    const callCtx: ToolContext = {
      ...ctx,
      onOutput: (delta) => emit({ type: "tool-delta", call, delta }),
    };
    const result = await tool.execute(args, callCtx);
    // A tool that returns an `ERROR:` string rather than throwing still failed;
    // the guards must see it that way or a tool that never throws is invisible.
    const ok = !looksFailed(result);
    emit({ type: "tool-end", call, result, ok, cwd });
    ledger?.observeToolCall(call.name, args, ok);
    if (ok && opts.storeToolCache) await opts.storeToolCache(call, args, result).catch(() => undefined);
    if (opts.afterTool) await opts.afterTool(call, result, ok).catch(() => undefined);
    return out(result, { ok });
  } catch (err) {
    const msg = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    emit({ type: "tool-end", call, result: msg, ok: false, cwd });
    ledger?.observeToolCall(call.name, args, false);
    if (opts.afterTool) await opts.afterTool(call, msg, false).catch(() => undefined);
    return out(msg, { ok: false });
  }
}

function safeSummary(
  summarize: (args: Record<string, unknown>) => string,
  args: Record<string, unknown>,
  fallback: string,
): string {
  try {
    return summarize(args) || fallback;
  } catch {
    return fallback;
  }
}

function safeMeta(
  meta: ((args: Record<string, unknown>, ctx: ToolContext) => { cwd?: string }) | undefined,
  args: Record<string, unknown>,
  ctx: ToolContext,
): string | undefined {
  if (!meta) return undefined;
  try {
    return meta(args, ctx).cwd;
  } catch {
    return undefined;
  }
}


/**
 * Persist images a chat model produced inside its completion and return one
 * embed directive per stored picture. Needs a host image bridge with `save`;
 * without one the pictures cannot be stored, so the reply keeps the text only.
 */
async function storeStreamImages(images: StreamImage[], ctx: ToolContext): Promise<string[]> {
  const bridge = ctx.imageGen;
  if (!bridge?.save) return [];
  const lines: string[] = [];
  for (const image of images) {
    try {
      const stored = await bridge.save({
        ...(image.base64 !== undefined ? { base64: image.base64 } : {}),
        ...(image.url !== undefined ? { url: image.url } : {}),
        mediaType: image.mediaType,
      });
      lines.push(inlineImageDirective(stored.file));
    } catch (err) {
      // Surfaced in the reply rather than swallowed: the user asked for a picture.
      lines.push(`*(an image could not be stored: ${err instanceof Error ? err.message : String(err)})*`);
    }
  }
  return lines;
}
