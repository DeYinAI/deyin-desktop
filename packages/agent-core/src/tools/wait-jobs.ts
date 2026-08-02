import type { ToolDefinition } from "../types.js";
import { asOptionalNumber, asStringArray } from "./util.js";

/**
 * Collect results from background jobs started via task(is_background=true) or fleet.
 */
export function createWaitJobsTool(): ToolDefinition {
  return {
    name: "wait",
    description:
      "Block until background job(s) complete and return collected results. " +
      "Use after starting tasks with is_background=true or a background fleet.",
    tier: "read",
    parameters: {
      type: "object",
      properties: {
        job_ids: {
          type: "array",
          items: { type: "string" },
          description: "Background job IDs to wait for.",
        },
        block_until_ms: {
          type: "number",
          description: "Max time to wait in milliseconds (default 120000).",
        },
      },
      required: ["job_ids"],
    },
    summarize: (args) => {
      const ids = (args.job_ids as string[] | undefined) ?? [];
      return `wait (${ids.length} jobs)`;
    },
    async execute(args, ctx): Promise<string> {
      const jobIds = asStringArray(args.job_ids, "job_ids");
      if (jobIds.length === 0) return "ERROR: at least one job_id is required.";
      const blockUntilMs = asOptionalNumber(args.block_until_ms) ?? 120_000;

      if (!ctx.waitForJobs) {
        return "ERROR: background job collection is not available in this context.";
      }

      const jobs = await ctx.waitForJobs(jobIds, blockUntilMs);
      if (jobs.length === 0) {
        return `No results for job IDs: ${jobIds.join(", ")}.`;
      }

      let out = `Collected ${jobs.length} background job result(s):\n`;
      for (const job of jobs) {
        out += `── ${job.label} (${job.id}) ──\n`;
        out += `status: ${job.status}\n`;
        if (job.result) out += `${job.result.trim()}\n`;
        if (job.error) out += `[ERROR] ${job.error}\n`;
      }
      return out;
    },
  };
}
