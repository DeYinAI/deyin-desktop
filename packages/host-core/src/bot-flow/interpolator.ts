export interface InterpolationContext {
  stages: Record<string, { output?: string; diff?: string; branch?: string; error?: string }>;
  artifacts: Array<{ name: string; path: string; stageId: string; content?: string }>;
  inputs?: Record<string, string>;
  workspaceRoot: string;
}

/**
 * Interpolates variables within a prompt template.
 * Supported syntax:
 *   {{stage.<id>.output}}
 *   {{stage.<id>.diff}}
 *   {{stage.<id>.branch}}
 *   {{artifacts}}
 *   {{inputs.<name>}}
 *   {{workspace.root}}
 */
export function interpolatePrompt(template: string, ctx: InterpolationContext): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, expr: string) => {
    const trimmed = expr.trim();

    if (trimmed === "artifacts") {
      if (ctx.artifacts.length === 0) return "(No artifacts produced yet)";
      return ctx.artifacts
        .map((a) => `- ${a.name} (from stage ${a.stageId}):\n${a.content ? `\`\`\`\n${a.content}\n\`\`\`` : a.path}`)
        .join("\n\n");
    }

    if (trimmed === "workspace.root") {
      return ctx.workspaceRoot;
    }

    if (trimmed.startsWith("inputs.")) {
      const key = trimmed.slice("inputs.".length);
      return ctx.inputs?.[key] ?? "";
    }

    if (trimmed.startsWith("stage.")) {
      const parts = trimmed.split(".");
      if (parts.length >= 3) {
        const stageId = parts[1]!;
        const prop = parts[2]!;
        const stageData = ctx.stages[stageId];
        if (stageData) {
          if (prop === "output") return stageData.output ?? "";
          if (prop === "diff") return stageData.diff ?? "";
          if (prop === "branch") return stageData.branch ?? "";
          if (prop === "error") return stageData.error ?? "";
        }
      }
    }

    return "";
  });
}
