import { connectMcpServer, type McpServerDefinition } from "@deyin/agent-core";
import type { SecurityFindingsReport } from "../shared/types.js";
import type { CapabilityService } from "./capabilities.js";

const SECURITY_MCP = "deyin-security";

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content);
  return content
    .map((part) => {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        return (part as { text?: string }).text ?? "";
      }
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

function withWorkspaceEnv(def: McpServerDefinition, workspaceRoot: string | null): McpServerDefinition {
  return {
    ...def,
    env: {
      ...(def.env ?? {}),
      DEYIN_WORKSPACE: workspaceRoot ?? "",
    },
  };
}

async function callSecurityTool(
  capabilities: CapabilityService,
  workspaceRoot: string | null,
  toolName: string,
  args: Record<string, unknown>,
): Promise<SecurityFindingsReport> {
  const snap = await capabilities.snapshot();
  const def = snap.mcpServers.find((s) => s.name === SECURITY_MCP);
  if (!def) throw new Error("Security MCP server is not available. Enable the Security plugin.");
  const resolved = withWorkspaceEnv(capabilities.resolvePluginVariables(def), workspaceRoot);
  const { client, close } = await connectMcpServer(resolved);
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    const text = contentToText(result.content);
    return JSON.parse(text) as SecurityFindingsReport;
  } finally {
    await close();
  }
}

export async function scanRepoViaMcp(
  capabilities: CapabilityService,
  workspaceRoot: string | null,
): Promise<SecurityFindingsReport> {
  if (!workspaceRoot) throw new Error("Open a workspace folder before running a security scan.");
  return callSecurityTool(capabilities, workspaceRoot, "security_scan_repo", { root: workspaceRoot });
}

export async function scanDiffViaMcp(
  capabilities: CapabilityService,
  workspaceRoot: string | null,
  diff: string,
): Promise<SecurityFindingsReport> {
  return callSecurityTool(capabilities, workspaceRoot, "security_scan_diff", { diff });
}
