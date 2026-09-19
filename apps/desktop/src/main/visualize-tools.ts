import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "@deyin/agent-core";
import type { VisualizeStore } from "./visualize-store.js";

function escapeVisDirectiveAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "'");
}

export function createVisualizeWriteTool(service: VisualizeStore): ToolDefinition {
  return {
    name: "visualize_write",
    description:
      "Write an HTML visualization fragment for the current thread and embed in chat. " +
      "Accepts a bare file name (e.g. 'chart.html', 'status.html') or a workspace-relative path (e.g. 'subfolder/status.html'). " +
      "Writes to thread visualization storage for chat embedding, and also saves a workspace copy when a workspace path is provided. " +
      "Returns an embed directive to include in your reply.",
    tier: "write",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            "HTML file name or workspace-relative path (e.g. 'chart.html' or 'subfolder/chart.html'). Bare filename is used for the chat embed directive; workspace copy is saved at the specified path.",
        },
        html: { type: "string", description: "HTML body fragment (no full document wrapper)." },
        title: { type: "string", description: "Optional display title." },
      },
      required: ["file", "html"],
    },
    summarize: (args) => `visualize ${String(args.file ?? "")}`,
    execute: async (args, ctx) => {
      const threadId = ctx.sessionMeta?.threadId;
      if (!threadId) return "ERROR: no active thread for visualization.";
      const rawFile = String(args.file ?? "").trim();
      const html = String(args.html ?? "");
      const title = args.title ? String(args.title) : undefined;

      if (!rawFile || rawFile.includes("..")) {
        return "ERROR: Invalid visualization file name: path traversal ('..') is not permitted.";
      }

      const bareFile = basename(rawFile);
      if (!bareFile || bareFile === "." || bareFile === "..") {
        return "ERROR: Invalid visualization file name: bare filename could not be resolved.";
      }

      let written;
      try {
        written = service.writeFragment(threadId, bareFile, html);
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }

      let workspaceNote = "";
      if (ctx.cwd) {
        try {
          const targetPath = isAbsolute(rawFile) ? resolve(rawFile) : resolve(ctx.cwd, rawFile);
          const root = resolve(ctx.cwd);
          if (targetPath === root || targetPath.startsWith(root + sep)) {
            mkdirSync(dirname(targetPath), { recursive: true });
            writeFileSync(targetPath, html, "utf8");
            workspaceNote = ` and workspace copy at ${relative(ctx.cwd, targetPath) || targetPath}`;
          }
        } catch (err) {
          console.warn("[deyin] failed to write visualize workspace copy:", err);
        }
      }

      const displayTitle = title ?? written.title;
      const fileAttr = escapeVisDirectiveAttr(written.title);
      const titleAttr = escapeVisDirectiveAttr(displayTitle);
      return `Wrote visualization to ${written.file}${workspaceNote}. Embed in your reply with:\n::deyin-inline-vis{file="${fileAttr}" title="${titleAttr}"}`;
    },
  };
}
