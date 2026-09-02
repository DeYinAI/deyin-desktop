import type { AgentMessage, ToolContext, ToolDefinition } from "../types.js";

const DEFAULT_PAGE_CHARS = 8_000;
const MAX_PAGE_CHARS = 32_000;

export const readSessionContextTool: ToolDefinition = {
  name: "read_session_context",
  description:
    "Read session context. With no arguments: session metadata (mode, workspace, model) and a short digest of recent turns. With tool_call_id: the full raw text of one earlier tool result, paged — pass the id that a snipped-result or duplicate marker names, using offset_chars/max_chars to walk it in pages.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      tool_call_id: {
        type: "string",
        description: "The tool_call_id whose full raw result to page back (named by a snip or duplicate marker).",
      },
      offset_chars: { type: "number", description: "Start offset in characters (default 0)." },
      max_chars: {
        type: "number",
        description: `Page size in characters (default ${DEFAULT_PAGE_CHARS}, max ${MAX_PAGE_CHARS}).`,
      },
    },
  },
  summarize: (args) =>
    typeof args.tool_call_id === "string" ? `page result ${args.tool_call_id}` : "session context",
  async execute(args, ctx): Promise<string> {
    const id = typeof args.tool_call_id === "string" ? args.tool_call_id.trim() : "";
    if (id) return pageToolResult(id, args, ctx);

    const meta = ctx.sessionMeta ?? {};
    const lines = [
      `threadId: ${meta.threadId ?? "(unknown)"}`,
      `mode: ${meta.mode ?? "(unknown)"}`,
      `approvalMode: ${meta.approvalMode ?? "(unknown)"}`,
      `model: ${meta.model ?? "(unknown)"}`,
      `cwd: ${meta.cwd ?? ctx.cwd}`,
      `todoCount: ${ctx.todos.length}`,
      `skills: ${(ctx.skills ?? []).map((s) => s.name).join(", ") || "(none)"}`,
    ];
    const messages = ctx.messages ?? [];
    const recent = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-6)
      .map((m) => {
        const body = typeof m.content === "string" ? m.content : "";
        return `${m.role}: ${body.slice(0, 200)}${body.length > 200 ? "…" : ""}`;
      });
    if (recent.length > 0) {
      lines.push("", "Recent transcript:", ...recent);
    }
    return lines.join("\n");
  },
};

/**
 * Page back one tool result. The raw store holds the pre-snip bytes for results
 * this run snipped; everything else falls back to the provider-visible copy,
 * which may already have lost its middle.
 */
function pageToolResult(id: string, args: Record<string, unknown>, ctx: ToolContext): string {
  const offset = Math.max(0, Math.floor(Number(args.offset_chars) || 0));
  const maxChars = Math.min(
    MAX_PAGE_CHARS,
    Math.max(1, Math.floor(Number(args.max_chars) || DEFAULT_PAGE_CHARS)),
  );

  const raw = ctx.rawResults?.get(id);
  if (raw) {
    if (offset >= raw.content.length) {
      return `tool_call_id=${id} (${raw.toolName}): offset ${offset} is past the end of the ${raw.content.length}-character result.`;
    }
    const page = raw.content.slice(offset, offset + maxChars);
    const end = offset + page.length;
    const more =
      end < raw.content.length
        ? `\n\n[... ${raw.content.length - end} more characters; continue with offset_chars=${end}]`
        : "";
    return `[${raw.toolName} raw result ${id}: characters ${offset}-${end} of ${raw.content.length}]\n\n${page}${more}`;
  }

  const surface = (ctx.messages ?? []).find(
    (m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool" && m.toolCallId === id,
  );
  if (!surface) {
    return `No result found for tool_call_id=${id}. Only results produced in this run can be paged back; re-run the tool with narrower arguments instead.`;
  }
  const page = surface.content.slice(offset, offset + maxChars);
  return [
    `[${surface.toolName} result ${id}: raw copy no longer retained (evicted or from an earlier run)`,
    "— serving the provider-visible copy, which may be snipped or pruned]",
    "",
    page,
  ].join("\n");
}
