import type { ToolDefinition } from "../types.js";

export const readSessionContextTool: ToolDefinition = {
  name: "read_session_context",
  description: "Read session metadata: mode, workspace, model, and recent transcript summary.",
  tier: "read",
  parameters: { type: "object", properties: {} },
  summarize: () => "session context",
  async execute(_args, ctx): Promise<string> {
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
