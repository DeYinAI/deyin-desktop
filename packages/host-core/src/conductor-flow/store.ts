import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "../storage.js";
import type { ConductorWorkflowDefinition } from "../types.js";

interface WorkflowsState {
  workflows: ConductorWorkflowDefinition[];
}

/** A fixed root, or a getter for hosts where the open workspace changes while the app runs. */
export type WorkspaceRootSource = string | null | undefined | (() => string | null | undefined);

export class ConductorWorkflowsStore {
  private state: WorkflowsState;

  constructor(
    private readonly storage?: Storage,
    private readonly workspaceRoot?: WorkspaceRootSource,
  ) {
    if (this.storage) {
      // `bot-workflows.json` is where pipelines lived before Conductor's ids left "bot".
      // It is read only while the new file does not exist yet; the first save moves
      // everything into `conductor-workflows.json` and the old file is never read again.
      this.state =
        this.storage.readJson<WorkflowsState | null>("conductor-workflows.json", null) ??
        this.storage.readJson<WorkflowsState>("bot-workflows.json", { workflows: [] });
    } else {
      this.state = { workflows: [] };
    }
  }

  private persist(): void {
    if (this.storage) {
      this.storage.writeJson("conductor-workflows.json", this.state);
    }
  }

  /** `<workspace>/.deyin/workflows`, where pipelines written as files (by the agent or by hand) live. */
  private workflowsDir(): string | null {
    const root = typeof this.workspaceRoot === "function" ? this.workspaceRoot() : this.workspaceRoot;
    return root ? join(root, ".deyin", "workflows") : null;
  }

  /** Pipelines defined as files in the current workspace, with the file each came from. */
  private workspaceFiles(): Array<{ path: string; workflow: ConductorWorkflowDefinition }> {
    const dir = this.workflowsDir();
    if (!dir || !existsSync(dir)) return [];
    const found: Array<{ path: string; workflow: ConductorWorkflowDefinition }> = [];
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return [];
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const path = join(dir, file);
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as ConductorWorkflowDefinition;
        if (parsed.id && parsed.stages) found.push({ path, workflow: parsed });
      } catch {
        // A half-written or hand-broken file is skipped; it shows up once it parses.
      }
    }
    return found;
  }

  list(): ConductorWorkflowDefinition[] {
    const list = [...this.state.workflows];
    for (const { workflow } of this.workspaceFiles()) {
      if (!list.some((w) => w.id === workflow.id)) list.push(workflow);
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): ConductorWorkflowDefinition | undefined {
    return this.list().find((w) => w.id === id);
  }

  save(workflow: ConductorWorkflowDefinition): ConductorWorkflowDefinition {
    const now = Date.now();
    const existingIdx = this.state.workflows.findIndex((w) => w.id === workflow.id);
    const item: ConductorWorkflowDefinition = {
      ...workflow,
      id: workflow.id || randomUUID(),
      createdAt: workflow.createdAt || now,
      updatedAt: now,
    };

    if (existingIdx >= 0) {
      this.state.workflows[existingIdx] = item;
    } else {
      this.state.workflows.push(item);
    }

    this.persist();
    return item;
  }

  /** Remove a pipeline, including the workspace file it was defined in, so it does not reappear on the next list. */
  delete(id: string): boolean {
    const before = this.state.workflows.length;
    this.state.workflows = this.state.workflows.filter((w) => w.id !== id);
    let removed = this.state.workflows.length !== before;
    if (removed) this.persist();

    for (const file of this.workspaceFiles()) {
      if (file.workflow.id !== id) continue;
      try {
        unlinkSync(file.path);
        removed = true;
      } catch {
        // Already gone or read-only: the pipeline stays listed, which tells the user it was not removed.
      }
    }
    return removed;
  }
}
