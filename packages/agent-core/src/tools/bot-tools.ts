import type { ToolDefinition } from "../types.js";
import { asString, asOptionalNumber } from "./util.js";
import { fastWatchdogCheck, fastRingBufferGetLines } from "../native.js";

export const listExternalBotsTool: ToolDefinition = {
  name: "list_external_bots",
  description:
    "List external AI coding tools and desktop clients detected on this system (e.g., Claude Code, OpenAI Codex CLI, OpenCode, ZCode/Zed, Cursor). Shows whether each tool is installed, authenticated, and ready.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      forceRefresh: {
        type: "boolean",
        description: "Force re-probing the system instead of using cached discovery results.",
      },
    },
  },
  summarize: () => "list external bots",
  async execute(args, ctx): Promise<string> {
    if (typeof (ctx as any).listExternalAgents === "function") {
      try {
        const agents = await (ctx as any).listExternalAgents(args.forceRefresh === true);
        return JSON.stringify(agents, null, 2);
      } catch (err: any) {
        return `Error listing external bots: ${err.message}`;
      }
    }
    return "External bot discovery is not available in this host environment.";
  },
};

export const delegateExternalBotTool: ToolDefinition = {
  name: "delegate_external_bot",
  description:
    "Delegate a task or stage to an external AI client (e.g. 'codex', 'claude', 'opencode', 'zcode'). Runs the external client with real-time watchdog heartbeat tracking.",
  tier: "execute",
  parameters: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "Target external agent ID ('codex' | 'claude' | 'opencode' | 'zcode' | 'cursor').",
      },
      prompt: {
        type: "string",
        description: "Task prompt to send to the external client.",
      },
      model: {
        type: "string",
        description: "Optional model override within the chosen client (e.g., 'gpt-5.3-codex', 'claude-4.6-sonnet').",
      },
      timeoutMinutes: {
        type: "number",
        description: "Maximum timeout in minutes before aborting (default: 15).",
      },
      stallMinutes: {
        type: "number",
        description: "Inactivity watchdog threshold in minutes before flagging a stall (default: 2).",
      },
    },
    required: ["agentId", "prompt"],
  },
  summarize: (args) => `delegate to ${String(args.agentId ?? "bot")}`,
  async execute(args, ctx): Promise<string> {
    const agentId = asString(args.agentId, "agentId");
    const prompt = asString(args.prompt, "prompt");
    const model = typeof args.model === "string" ? args.model : undefined;
    const timeoutMs = (asOptionalNumber(args.timeoutMinutes) ?? 15) * 60 * 1000;
    const stallThresholdMs = (asOptionalNumber(args.stallMinutes) ?? 2) * 60 * 1000;

    if (typeof (ctx as any).runExternalAgent === "function") {
      try {
        const res = await (ctx as any).runExternalAgent({
          agentId,
          prompt,
          cwd: ctx.cwd,
          model,
          timeoutMs,
          stallThresholdMs,
        });
        const runIdPrefix = res?.runId ? `[Run ID: ${res.runId}]\n` : "";
        if (!res.ok) {
          return `${runIdPrefix}ERROR from ${agentId}: ${res.error}\n\nOutput:\n${res.outputText}`;
        }
        return `${runIdPrefix}SUCCESS from ${agentId}:\n${res.outputText}`;
      } catch (err: any) {
        return `Failed to delegate to ${agentId}: ${err.message}`;
      }
    }

    return `External bot runner is not connected in this context. Cannot delegate to '${agentId}'.`;
  },
};

export const inspectBotRunTool: ToolDefinition = {
  name: "inspect_bot_run",
  description:
    "Check live watchdog status, elapsed time, and recent terminal log lines for an external bot execution.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      runId: {
        type: "string",
        description: "The execution run ID to inspect.",
      },
      maxLines: {
        type: "number",
        description: "Number of recent terminal lines to retrieve (default: 50).",
      },
    },
    required: ["runId"],
  },
  summarize: (args) => `inspect bot run ${String(args.runId ?? "")}`,
  async execute(args): Promise<string> {
    const runId = asString(args.runId, "runId");
    const maxLines = asOptionalNumber(args.maxLines) ?? 50;

    const check = fastWatchdogCheck(runId, Date.now());
    const lines = fastRingBufferGetLines(runId, maxLines);

    return JSON.stringify(
      {
        runId,
        watchdogStatus: check.status,
        elapsedSeconds: Math.round(check.elapsedMs / 1000),
        inactiveSeconds: Math.round(check.inactiveMs / 1000),
        recentLogs: lines,
      },
      null,
      2,
    );
  },
};

export const mergeBotDiffTool: ToolDefinition = {
  name: "merge_bot_diff",
  description:
    "Merge a completed bot worktree branch into the active workspace branch.",
  tier: "execute",
  parameters: {
    type: "object",
    properties: {
      branchName: {
        type: "string",
        description: "The bot worktree branch to merge (e.g. 'bot/stage-checkout-a8b2').",
      },
    },
    required: ["branchName"],
  },
  summarize: (args) => `merge bot branch ${String(args.branchName ?? "")}`,
  async execute(args, ctx): Promise<string> {
    const branchName = asString(args.branchName, "branchName");
    if (typeof (ctx as any).mergeBotBranch === "function") {
      try {
        const res = await (ctx as any).mergeBotBranch(ctx.cwd, branchName);
        return res.ok ? `Merged ${branchName} successfully.` : `Merge failed: ${res.message}`;
      } catch (err: any) {
        return `Merge error: ${err.message}`;
      }
    }
    return `Branch merge helper not available in this context.`;
  },
};
