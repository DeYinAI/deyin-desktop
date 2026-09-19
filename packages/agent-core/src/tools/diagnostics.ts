import type { ToolDefinition } from "../types.js";
import { formatDiagnostics } from "../loop.js";

function asStringOrUndefined(val: unknown): string | undefined {
  if (typeof val === "string" && val.trim().length > 0) return val.trim();
  return undefined;
}

export const diagnosticsTool: ToolDefinition = {
  name: "diagnostics",
  description:
    "Query compiler or language-server diagnostics (type errors, syntax errors, lint issues) for a specific file or the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Optional workspace-relative or absolute file path to check diagnostics for. Omit to query workspace-wide diagnostics.",
      },
    },
  },
  tier: "read",
  summarize: (args) => (args.path ? `diagnostics: ${String(args.path)}` : "diagnostics: workspace"),
  async execute(args, ctx): Promise<string> {
    const targetPath = asStringOrUndefined(args.path);
    if (!ctx.getDiagnostics) {
      return targetPath
        ? `No active language server or compiler diagnostics provider configured for "${targetPath}".`
        : "No active language server or compiler diagnostics provider configured for this workspace.";
    }

    try {
      const paths = targetPath ? [targetPath] : undefined;
      const diags = await ctx.getDiagnostics(paths);
      if (!diags || diags.length === 0) {
        return targetPath
          ? `No diagnostic errors or warnings found in "${targetPath}".`
          : "No diagnostic errors or warnings found in the workspace.";
      }
      return formatDiagnostics(diags);
    } catch (err) {
      return `Diagnostics provider failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
