/**
 * Codex-style confirmation taxonomy for computer_use tools.
 * Maps tool + args to whether user confirmation is required beyond tier defaults.
 */
export type ComputerUseRisk = "low" | "medium" | "high";

export interface ComputerUseActionContext {
  toolName: string;
  args: Record<string, unknown>;
}

const HIGH_RISK_TOOLS = new Set(["computer_launch_app", "computer_type", "computer_drag"]);
const MEDIUM_RISK_TOOLS = new Set(["computer_click", "computer_press_key", "computer_scroll", "computer_set_value"]);

const HIGH_RISK_KEYWORDS = /purchase|buy|pay|delete|remove|send|submit|confirm|login|sign.?in|password/i;

export function computerUseConfirmationRequired(ctx: ComputerUseActionContext): boolean {
  const { toolName, args } = ctx;
  if (toolName === "computer_launch_app") return true;
  if (HIGH_RISK_TOOLS.has(toolName)) {
    const text = JSON.stringify(args);
    if (HIGH_RISK_KEYWORDS.test(text)) return true;
    if (toolName === "computer_type" && String(args.text ?? "").length > 80) return true;
  }
  if (MEDIUM_RISK_TOOLS.has(toolName) && args.perform_secondary === true) return true;
  return false;
}

export function computerUseRiskLevel(ctx: ComputerUseActionContext): ComputerUseRisk {
  if (computerUseConfirmationRequired(ctx)) return "high";
  if (MEDIUM_RISK_TOOLS.has(ctx.toolName)) return "medium";
  return "low";
}

export function computerUsePermissionRules(): Array<{ tool: string; action: "ask" | "allow" }> {
  return [
    { tool: "computer_list_apps", action: "allow" },
    { tool: "computer_list_windows", action: "allow" },
    { tool: "computer_get_state", action: "allow" },
    { tool: "computer_launch_app", action: "ask" },
    { tool: "computer_click", action: "ask" },
    { tool: "computer_type", action: "ask" },
    { tool: "computer_press_key", action: "ask" },
    { tool: "computer_scroll", action: "ask" },
    { tool: "computer_drag", action: "ask" },
  ];
}
