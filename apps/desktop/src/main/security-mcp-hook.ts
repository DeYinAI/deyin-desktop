import type { ToolRegistry } from "@deyin/agent-core";
import type { SecurityFindingsReport } from "@deyin/contract";
import type { SecurityFindingsStore } from "./security-findings-store.js";

const SECURITY_SERVER = "deyin-security";
const SCAN_TOOLS = new Set(["security_scan_repo", "security_scan_diff"]);

/** Persist validated security scan tool output for the active thread. */
export function wrapSecurityMcpTools(
  registry: ToolRegistry,
  threadId: string,
  store: SecurityFindingsStore,
  onSaved?: () => void,
): void {
  for (const name of registry.names()) {
    const prefix = `mcp__${SECURITY_SERVER}__`;
    if (!name.startsWith(prefix)) continue;
    const toolName = name.slice(prefix.length);
    if (!SCAN_TOOLS.has(toolName)) continue;
    const tool = registry.get(name);
    if (!tool) continue;
    const inner = tool.execute.bind(tool);
    registry.register({
      ...tool,
      async execute(args, ctx) {
        const result = await inner(args, ctx);
        try {
          const parsed = JSON.parse(result) as SecurityFindingsReport;
          if (parsed?.version === "1" && Array.isArray(parsed.findings)) {
            store.mergeReport(threadId, parsed);
            onSaved?.();
          }
        } catch {
          // Non-JSON tool output is ignored.
        }
        return result;
      },
    });
  }
}
