/**
 * DeepSeek-specific optimizations for cache performance.
 * 
 * Key DeepSeek API behaviors for prefix caching:
 * - DeepSeek manages prefix caching automatically (no cache_control markers needed)
 * - reasoning_content must round-trip on tool-call turns
 * - Beta endpoint supports prefix continuation for truncated responses
 * - 64-token cache block granularity
 */

/**
 * Detect if a base URL is DeepSeek's API.
 */
export function isDeepSeekEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname.includes("deepseek.com") || url.hostname.includes("deepseek.ai");
  } catch {
    return false;
  }
}

/**
 * Get DeepSeek's beta continuation endpoint for prefix-based continuations.
 * Returns null if not a DeepSeek endpoint.
 */
export function getDeepSeekBetaEndpoint(chatUrl: string): string | null {
  if (!isDeepSeekEndpoint(chatUrl)) {
    return null;
  }
  
  try {
    const url = new URL(chatUrl);
    url.pathname = "/beta/chat/completions";
    return url.toString();
  } catch {
    return null;
  }
}

/** Returns true when the model stopped because it hit max_tokens (finish_reason: "length"). */
export function shouldContinueResponse(finishReason: string | undefined): boolean {
  return finishReason === "length";
}
