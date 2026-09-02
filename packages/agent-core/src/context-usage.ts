import { priceMessages } from "./context-measure.js";
import { countTokens } from "./tokenizer.js";
import { TASK_SUBAGENT_CATALOG_MARKER } from "./tools/task.js";
import type { AgentMessage, WireTool } from "./types.js";

/** Category ids shown in the Context Usage popover (non-overlapping). */
export type ContextCategoryId =
  | "system"
  | "tools"
  | "rules"
  | "skills"
  | "mcp"
  | "subagents"
  | "conversation";

export interface ContextCategory {
  id: ContextCategoryId;
  label: string;
  tokens: number;
}

export interface ContextSnapshot {
  contextLength: number;
  usedTokens: number;
  percent: number;
  categories: ContextCategory[];
  /** Present when wire compression ran for this estimate (tokenizer units). */
  wire?: { originalTokens: number; compressedTokens: number };
  /** True when an optimization response-cache hit short-circuited the run. */
  cached?: boolean;
}

/** Structured system-prompt slices used for non-overlapping category accounting. */
export interface SystemPromptSections {
  /** Identity + mode + environment + tool rules. */
  system: string;
  /** Skills advertisement (empty when none). */
  skills: string;
  /** Project rules / AGENTS.md / hook context (empty when none). */
  rules: string;
}

export interface EstimateContextOptions {
  /** Model context window; 0/undefined → percent is 0 (never invent a default). */
  contextLength?: number;
  messages: AgentMessage[];
  /** Prefer these over parsing messages[0] for system/skills/rules. */
  systemSections?: SystemPromptSections;
  tools?: WireTool[];
  /**
   * Pre-split tool-schema tokens. The split is a pure function of `tools`, which
   * is constant while the tool surface is, so the caller computes it once per
   * tool-list change instead of re-`JSON.stringify`ing ~70 schemas every step.
   */
  schemaSplit?: { tools: number; mcp: number; subagents: number };
  /**
   * Compression savings measured by the request that actually went out.
   *
   * This used to be produced by running `buildWireMessages` over the whole
   * transcript a second time, purely to fill a UI line — an O(total chars) regex
   * pass on the synchronous hot path, once per step, duplicating the pass the
   * real request had already done. The caller reports its own numbers instead.
   */
  compression?: { originalTokens: number; compressedTokens: number };
  cached?: boolean;
}

const LABELS: Record<ContextCategoryId, string> = {
  system: "System prompt",
  tools: "Tool definitions",
  rules: "Rules",
  skills: "Skills",
  mcp: "MCP & dynamic tools",
  subagents: "Subagent definitions",
  conversation: "Conversation",
};

const CATEGORY_ORDER: ContextCategoryId[] = [
  "system",
  "tools",
  "rules",
  "skills",
  "mcp",
  "subagents",
  "conversation",
];

/** Estimate tokens for a JSON-serialized tool schema. */
export function estimateToolSchemaTokens(tool: WireTool): number {
  return countTokens(JSON.stringify(tool));
}

/**
 * Split wire tools into builtin / MCP / subagent-catalog buckets.
 * The `task` tool's subagent catalog is counted under subagents; the rest of
 * its schema stays under tools so categories stay non-overlapping and conserve
 * the full schema token count (`tools + subagents === full task schema`).
 */
export function splitToolSchemaTokens(tools: WireTool[]): {
  tools: number;
  mcp: number;
  subagents: number;
} {
  let builtin = 0;
  let mcp = 0;
  let subagents = 0;

  for (const tool of tools) {
    const name = tool.function.name;
    if (name.startsWith("mcp__")) {
      mcp += estimateToolSchemaTokens(tool);
      continue;
    }
    if (name === "task") {
      const full = estimateToolSchemaTokens(tool);
      const desc = tool.function.description ?? "";
      const marker = desc.indexOf(TASK_SUBAGENT_CATALOG_MARKER);
      if (marker >= 0) {
        const withoutCatalog: WireTool = {
          ...tool,
          function: {
            ...tool.function,
            description: desc.slice(0, marker + TASK_SUBAGENT_CATALOG_MARKER.length),
          },
        };
        const without = estimateToolSchemaTokens(withoutCatalog);
        builtin += without;
        subagents += Math.max(0, full - without);
      } else {
        builtin += full;
      }
      continue;
    }
    builtin += estimateToolSchemaTokens(tool);
  }

  return { tools: builtin, mcp, subagents };
}

function resolveSystemSections(
  messages: AgentMessage[],
  sections?: SystemPromptSections,
): SystemPromptSections {
  if (sections) return sections;
  const systemMsg = messages.find((m) => m.role === "system");
  return { system: systemMsg?.content ?? "", skills: "", rules: "" };
}

/**
 * Build a context-window snapshot for the UI: category breakdown + percent full.
 * Uses the tokenizer estimator (same family as compaction and wire compression stats).
 */
export function estimateContextUsage(opts: EstimateContextOptions): ContextSnapshot {
  const contextLength = Math.max(0, opts.contextLength ?? 0);
  const sections = resolveSystemSections(opts.messages, opts.systemSections);

  const systemTokens = countTokens(sections.system);
  const skillsTokens = countTokens(sections.skills);
  const rulesTokens = countTokens(sections.rules);

  // priceMessage, not estimateMessageTokens: the former is memoised on message
  // identity (a WeakMap in context-measure) and is the same estimator the
  // compaction threshold uses, so the meter and the trigger now agree instead of
  // reporting two different numbers for one transcript.
  const conversationMessages = opts.messages.filter((m) => m.role !== "system");
  const conversationTokens = priceMessages(conversationMessages);

  const split = opts.schemaSplit ?? splitToolSchemaTokens(opts.tools ?? []);

  const byId: Record<ContextCategoryId, number> = {
    system: systemTokens,
    tools: split.tools,
    rules: rulesTokens,
    skills: skillsTokens,
    mcp: split.mcp,
    subagents: split.subagents,
    conversation: conversationTokens,
  };

  const categories: ContextCategory[] = CATEGORY_ORDER.map((id) => ({
    id,
    label: LABELS[id],
    tokens: byId[id],
  }));

  const usedTokens = categories.reduce((sum, c) => sum + c.tokens, 0);
  const percent =
    contextLength > 0 ? Math.min(100, Math.round((usedTokens / contextLength) * 100)) : 0;

  const wire: ContextSnapshot["wire"] = opts.compression
    ? { originalTokens: opts.compression.originalTokens, compressedTokens: opts.compression.compressedTokens }
    : undefined;

  return {
    contextLength,
    usedTokens,
    percent,
    categories,
    wire,
    cached: opts.cached,
  };
}
