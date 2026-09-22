import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { BotWorkflowsStore, BotWorkflowEngine } from "@deyin/host-core";
import type { ExternalAgentService } from "./service.js";

export class BotWorkflowScheduler {
  private jobs = new Map<string, Cron | NodeJS.Timeout>();
  private activeExecutions = new Set<string>();
  private disposed = false;

  constructor(
    private readonly store: BotWorkflowsStore,
    private readonly engine: BotWorkflowEngine,
    private readonly externalAgents: ExternalAgentService,
    private readonly getWorkspaceRoot: () => string | null,
    private readonly broadcastEvent: (event: any) => void,
  ) {
    this.refresh();
  }

  isWorkflowRunning(workflowId: string): boolean {
    return this.activeExecutions.has(workflowId);
  }

  refresh(): void {
    this.disposeJobs();
    if (this.disposed) return;

    for (const workflow of this.store.list()) {
      if (!workflow.schedule?.enabled) continue;

      const cronExpr = workflow.schedule.cronExpression?.trim();
      if (cronExpr && cronExpr.length > 0) {
        try {
          const job = new Cron(cronExpr, { protect: true }, () => {
            this.trigger(workflow.id);
          });
          this.jobs.set(workflow.id, job);
        } catch (err) {
          console.error(`[bot-scheduler] Invalid cron for workflow ${workflow.id}:`, err);
        }
      } else if (workflow.schedule.intervalMinutes && workflow.schedule.intervalMinutes > 0) {
        const intervalMs = workflow.schedule.intervalMinutes * 60 * 1000;
        const timer = setInterval(() => {
          this.trigger(workflow.id);
        }, intervalMs);
        timer.unref();
        this.jobs.set(workflow.id, timer);
      }
    }
  }

  private trigger(workflowId: string): void {
    if (this.activeExecutions.has(workflowId)) {
      console.warn(`[bot-scheduler] Workflow ${workflowId} is already running, skipping scheduled tick.`);
      return;
    }

    const wf = this.store.get(workflowId);
    if (!wf) return;
    const cwd = this.getWorkspaceRoot() || process.cwd();

    const runId = randomUUID();
    this.activeExecutions.add(workflowId);
    void this.engine
      .execute({
        workflow: wf,
        workspaceRoot: cwd,
        runId,
        runner: (opts) =>
          this.externalAgents.runAgent({
            ...opts,
            runId: opts.runId ?? `${runId}-${opts.stageId ?? randomUUID()}`,
            logBufferId: runId,
          }),
        onEvent: (event) => this.broadcastEvent(event),
      })
      .finally(() => {
        this.activeExecutions.delete(workflowId);
      });
  }

  disposeJobs(): void {
    for (const job of this.jobs.values()) {
      if ("stop" in job && typeof job.stop === "function") {
        job.stop();
      } else {
        clearInterval(job as NodeJS.Timeout);
      }
    }
    this.jobs.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.disposeJobs();
    this.activeExecutions.clear();
  }
}
