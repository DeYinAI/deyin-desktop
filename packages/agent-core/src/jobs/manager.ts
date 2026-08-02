import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type JobStatus = "running" | "completed" | "failed" | "stopped";

export interface BackgroundJob {
  id: string;
  sessionId: string;
  kind: string;
  label: string;
  profile?: string;
  prompt: string;
  startTime: number;
  endTime?: number;
  status: JobStatus;
  result?: string;
  error?: string;
}

export interface JobCompletionNote {
  jobId: string;
  label: string;
  status: JobStatus;
  summary: string;
}

/**
 * Session-scoped background job registry with JSONL persistence.
 */
export class JobsManager {
  private jobs = new Map<string, BackgroundJob>();
  private pendingNotes: JobCompletionNote[] = [];

  constructor(
    private readonly sessionId: string,
    private readonly persistPath?: string,
  ) {
    if (persistPath && existsSync(persistPath)) {
      this.loadFromDisk();
      this.recoverStaleJobs(60_000);
    }
  }

  register(job: Omit<BackgroundJob, "id" | "startTime" | "status" | "sessionId"> & { id?: string }): BackgroundJob {
    const full: BackgroundJob = {
      id: job.id ?? randomUUID(),
      sessionId: this.sessionId,
      kind: job.kind,
      label: job.label,
      profile: job.profile,
      prompt: job.prompt,
      startTime: Date.now(),
      status: "running",
    };
    this.jobs.set(full.id, full);
    this.persist(full);
    return full;
  }

  updateStatus(jobId: string, status: JobStatus, result?: string, error?: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = status;
    job.endTime = Date.now();
    if (result != null) job.result = result;
    if (error != null) job.error = error;
    this.persist(job);
    if (status === "completed" || status === "failed" || status === "stopped") {
      this.pendingNotes.push({
        jobId: job.id,
        label: job.label,
        status,
        summary: (result ?? error ?? "").slice(0, 500),
      });
    }
  }

  get(jobId: string): BackgroundJob | undefined {
    return this.jobs.get(jobId);
  }

  getPending(): BackgroundJob[] {
    return [...this.jobs.values()].filter((j) => j.status === "running");
  }

  getCompleted(): BackgroundJob[] {
    return [...this.jobs.values()].filter((j) => j.status === "completed");
  }

  /** Mark jobs stuck in running state after a crash as failed. Returns count recovered. */
  recoverStaleJobs(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "running" && now - job.startTime > maxAgeMs) {
        this.updateStatus(job.id, "failed", undefined, "recovered after crash (stale running job)");
        recovered += 1;
      }
    }
    return recovered;
  }

  /** Drain completion notes for injection into the next user turn. */
  drainCompletionNotes(): JobCompletionNote[] {
    const notes = [...this.pendingNotes];
    this.pendingNotes = [];
    return notes;
  }

  async waitFor(jobIds: string[], timeoutMs: number): Promise<BackgroundJob[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const allDone = jobIds.every((id) => {
        const job = this.jobs.get(id);
        return job && job.status !== "running";
      });
      if (allDone) {
        return jobIds.map((id) => this.jobs.get(id)).filter((j): j is BackgroundJob => j != null);
      }
      await new Promise((r) => setTimeout(r, Math.min(100, deadline - Date.now())));
    }
    return jobIds.map((id) => this.jobs.get(id)).filter((j): j is BackgroundJob => j != null);
  }

  private persist(job: BackgroundJob): void {
    if (!this.persistPath) return;
    mkdirSync(dirname(this.persistPath), { recursive: true });
    appendFileSync(this.persistPath, `${JSON.stringify(job)}\n`, "utf8");
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    const lines = readFileSync(this.persistPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const job = JSON.parse(line) as BackgroundJob;
        if (job.sessionId === this.sessionId) {
          this.jobs.set(job.id, job);
        }
      } catch {
        // skip corrupt lines
      }
    }
  }
}

const sessionManagers = new Map<string, JobsManager>();

export function getSessionJobsManager(sessionId: string, dataDir?: string): JobsManager {
  let mgr = sessionManagers.get(sessionId);
  if (!mgr) {
    const persistPath = dataDir ? join(dataDir, "jobs", `${sessionId}.jsonl`) : undefined;
    mgr = new JobsManager(sessionId, persistPath);
    sessionManagers.set(sessionId, mgr);
  }
  return mgr;
}

export function clearSessionJobsManager(sessionId: string): void {
  sessionManagers.delete(sessionId);
}
