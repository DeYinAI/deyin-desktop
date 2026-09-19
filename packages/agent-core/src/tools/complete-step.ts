import type { ToolDefinition } from "../types.js";
import { asString } from "./util.js";

export const completeStepTool: ToolDefinition = {
  name: "complete_step",
  description:
    "Sign off a todo step after verification. " +
    "CRITICAL: This tool is STRICTLY gated to delivery mode and requires an active evidence ledger. " +
    "Do NOT call complete_step in agent or plan mode; in those modes, update tasks directly with todo_write. " +
    "To use complete_step, first switch to delivery mode via switch_mode(mode: 'delivery'). " +
    "Requires step_id matching an active todo, verification_command that was actually run (bash), diff_summary, and optional review_notes.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      step_id: { type: "string", description: "Todo id to sign off (must match todo_write id)." },
      verification_command: {
        type: "string",
        description: "Exact shell command used to verify (must have run successfully this session).",
      },
      diff_summary: { type: "string", description: "Brief summary of file/workspace changes for this step." },
      review_notes: { type: "string", description: "Quality check notes (edge cases, risks, follow-ups)." },
    },
    required: ["step_id", "verification_command", "diff_summary"],
  },
  summarize: (args) => `complete step ${String(args.step_id ?? "")}`,
  async execute(args, ctx): Promise<string> {
    const stepId = asString(args.step_id, "step_id");
    const verificationCommand = asString(args.verification_command, "verification_command");
    const diffSummary = asString(args.diff_summary, "diff_summary");
    const reviewNotes = typeof args.review_notes === "string" ? args.review_notes : undefined;

    const ledger = ctx.evidenceLedger;
    if (!ledger) {
      const mode = ctx.sessionMeta?.mode ?? "current";
      return (
        `ERROR: complete_step is only available in delivery mode with evidence tracking enabled (current mode: "${mode}"). ` +
        `In ${mode} mode, manage task status directly using todo_write. ` +
        `If you need formal verification gates and sign-offs, switch to delivery mode first via switch_mode(mode: "delivery").`
      );
    }

    const todo = ctx.todos.find((t) => t.id === stepId);
    if (!todo) {
      return `ERROR: step_id "${stepId}" not found in the current todo list. Use todo_write ids exactly.`;
    }
    if (todo.status === "cancelled") {
      return `ERROR: step "${stepId}" is cancelled and cannot be signed off.`;
    }

    if (!ledger.hasRecentVerification(verificationCommand)) {
      return (
        `ERROR: verification_command not found in recent tool history. ` +
        `Run \`${verificationCommand}\` with bash first, confirm it succeeds, then call complete_step again.`
      );
    }

    const mutations = ledger.getMutations();
    if (mutations.length === 0 && !diffSummary.trim()) {
      return "ERROR: no mutations recorded and diff_summary is empty — provide what changed or run write/edit first.";
    }

    if (ledger.hasSignOffForStep(stepId)) {
      return `ERROR: step "${stepId}" is already signed off. Move to the next todo or update todo_write status.`;
    }

    ledger.recordSignOff({
      stepId,
      verificationCommand,
      diffSummary,
      reviewNotes,
    });

    todo.signedOff = true;
    if (reviewNotes) todo.signOffNotes = reviewNotes;
    if (todo.status === "pending") todo.status = "in_progress";
    ctx.onTodosChanged?.(ctx.todos);
    ctx.onEvidenceSignOff?.({ stepId, verificationCommand, diffSummary, reviewNotes });

    return (
      `Step "${stepId}" signed off.\n` +
      `Verification: ${verificationCommand}\n` +
      `Changes: ${diffSummary}` +
      (reviewNotes ? `\nReview: ${reviewNotes}` : "")
    );
  },
};
