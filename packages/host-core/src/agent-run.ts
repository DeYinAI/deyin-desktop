/**
 * Shared agent-run option building for every host (desktop, web, CLI headless).
 * One place decides wire compression, prompt-cache keys, and provider hints so
 * all runtimes get identical cache behaviour — previously only desktop did.
 */

/** Provider family hint used by the wire layer to pick cache markers. */
export type AgentRunProviderHint = "openference" | "openai" | "anthropic" | "deepseek" | "auto";

export interface AgentRunCacheOptions {
  /** Provider id from settings ("openference", a custom provider id, ...). */
  providerId: string;
  /** Model id requested for this run. */
  model: string;
  /** Workspace root the run operates in; keeps keys scoped per project. */
  cwd: string;
  /** Wire format of the target endpoint. */
  apiFormat?: string;
}

/**
 * Stable per-thread prompt-cache key: `deyin:{provider}:{model}:{cwd}`.
 * Deliberately excludes step/role so model routing never fragments
 * provider-side prefix caches (DeepSeek, OpenAI automatic caching).
 */
export function buildPromptCacheKeyFor(options: AgentRunCacheOptions): string {
  return `deyin:${options.providerId}:${options.model}:${options.cwd}`;
}

/**
 * Map an apiFormat/provider pair onto the wire-layer provider hint.
 * DeepSeek endpoints (chat-completions + deepseek base URL) get reasoning_content
 * roundtrip and beta continuation; Anthropic gets cache_control; others default.
 */
export function resolveWireProvider(options: AgentRunCacheOptions): AgentRunProviderHint {
  const base = options.apiFormat ?? "chat-completions";
  if (/deepseek/i.test(options.providerId) || /deepseek/i.test(options.model)) return "deepseek";
  if (base === "anthropic") return "anthropic";
  if (base === "responses") return "openai";
  if (options.providerId === "openference") return "openference";
  return "openai";
}
