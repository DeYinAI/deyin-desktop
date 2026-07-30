import { countTokens, estimateMessageTokens } from "./tokenizer.js";
import { TASK_SUBAGENT_CATALOG_MARKER } from "./tools/task.js";
import type { AgentMessage, WireTool } from "./types.js";
import { buildWireMessages, type WireOptions } from "./wire.js";

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
  /** When compression is enabled, include a wire savings line. */
  wire?: WireOptions;
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

  const conversationMessages = opts.messages.filter((m) => m.role !== "system");
  const conversationTokens = estimateMessageTokens(conversationMessages);

  const split = splitToolSchemaTokens(opts.tools ?? []);

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

  let wire: ContextSnapshot["wire"];
  if (opts.wire?.enableCompression) {
    const built = buildWireMessages(opts.messages, opts.wire);
    if (built.compression) {
      wire = {
        originalTokens: built.compression.originalTokens,
        compressedTokens: built.compression.compressedTokens,
      };
    }
  }

  return {
    contextLength,
    usedTokens,
    percent,
    categories,
    wire,
    cached: opts.cached,
  };
}
