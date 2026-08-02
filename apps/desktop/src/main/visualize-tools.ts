import type { ToolDefinition } from "@deyin/agent-core";
import type { VisualizeStore } from "./visualize-store.js";

function escapeVisDirectiveAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "'");
}

export function createVisualizeWriteTool(service: VisualizeStore): ToolDefinition {
  return {
    name: "visualize_write",
    description:
      "Write an HTML visualization fragment for the current thread. Returns an embed directive to include in your reply.",
    tier: "write",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "File name, e.g. chart.html" },
        html: { type: "string", description: "HTML body fragment (no full document wrapper)." },
        title: { type: "string", description: "Optional display title." },
      },
      required: ["file", "html"],
    },
    summarize: (args) => `visualize ${String(args.file ?? "")}`,
    execute: async (args, ctx) => {
      const threadId = ctx.sessionMeta?.threadId;
      if (!threadId) return "ERROR: no active thread for visualization.";
      const file = String(args.file ?? "");
      const html = String(args.html ?? "");
      const title = args.title ? String(args.title) : undefined;
      const written = service.writeFragment(threadId, file, html);
      const displayTitle = title ?? written.title;
      const fileAttr = escapeVisDirectiveAttr(written.title);
      const titleAttr = escapeVisDirectiveAttr(displayTitle);
      return `Wrote visualization to ${written.file}. Embed in your reply with:\n::deyin-inline-vis{file="${fileAttr}" title="${titleAttr}"}`;
    },
  };
}
