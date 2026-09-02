/**
 * Raw (pre-snip) tool results, kept in memory so the model can page them back.
 *
 * `snipToolResult` shrinks an oversized result before it ever becomes a
 * transcript message, so the middle of a big output used to be gone the moment
 * it was produced — while the snip marker kept telling the model to page it
 * back with `read_session_context`. This store is the other half of that
 * promise: snipped results are retained verbatim, bounded, keyed by the
 * `tool_call_id` the marker names. Reasonix makes the same distinction as
 * Content (provider-visible) vs RawContent (local, paged on demand).
 */

/** One retained raw result. `toolName` rides along so paging can label it. */
export interface RawToolResult {
  toolName: string;
  content: string;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_TOTAL_CHARS = 2_000_000;

export class RawResultStore {
  private readonly entries = new Map<string, RawToolResult>();
  private totalChars = 0;
  private evicted = 0;

  constructor(
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly maxTotalChars: number = DEFAULT_MAX_TOTAL_CHARS,
  ) {}

  /** How many retained results were dropped to stay within the bounds. */
  get evictedCount(): number {
    return this.evicted;
  }

  get size(): number {
    return this.entries.size;
  }

  record(toolCallId: string, toolName: string, content: string): void {
    // An entry that cannot fit even in an empty store could never be paged
    // whole; the surface copy (head+tail) is the best anyone can do.
    if (content.length > this.maxTotalChars) return;
    const previous = this.entries.get(toolCallId);
    if (previous) this.totalChars -= previous.content.length;
    // Re-insert so Map insertion order reflects recency for eviction.
    this.entries.delete(toolCallId);
    this.entries.set(toolCallId, { toolName, content });
    this.totalChars += content.length;
    this.evict();
  }

  get(toolCallId: string): RawToolResult | undefined {
    return this.entries.get(toolCallId);
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.totalChars > this.maxTotalChars) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      const entry = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (entry) this.totalChars -= entry.content.length;
      this.evicted += 1;
    }
  }
}
