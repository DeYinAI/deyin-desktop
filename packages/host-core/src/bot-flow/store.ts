import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "../storage.js";
import type { BotWorkflowDefinition } from "../types.js";

interface WorkflowsState {
  workflows: BotWorkflowDefinition[];
}

export class BotWorkflowsStore {
  private state: WorkflowsState;

  constructor(
    private readonly storage?: Storage,
    private readonly workspaceRoot?: string | null,
  ) {
    if (this.storage) {
      this.state = this.storage.readJson<WorkflowsState>("bot-workflows.json", { workflows: [] });
    } else {
      this.state = { workflows: [] };
    }
  }

  private persist(): void {
    if (this.storage) {
      this.storage.writeJson("bot-workflows.json", this.state);
    }
  }

  list(): BotWorkflowDefinition[] {
    const list = [...this.state.workflows];

    // Also scan workspace .deyin/workflows/*.json if available
    if (this.workspaceRoot) {
      const workspaceDir = join(this.workspaceRoot, ".deyin", "workflows");
      if (existsSync(workspaceDir)) {
        try {
          const files = readdirSync(workspaceDir);
          for (const file of files) {
            if (file.endsWith(".json")) {
              try {
                const content = readFileSync(join(workspaceDir, file), "utf8");
                const parsed = JSON.parse(content) as BotWorkflowDefinition;
                if (parsed.id && parsed.stages && !list.some((w) => w.id === parsed.id)) {
                  list.push(parsed);
                }
              } catch {}
            }
          }
        } catch {}
      }
    }

    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): BotWorkflowDefinition | undefined {
    return this.list().find((w) => w.id === id);
  }

  save(workflow: BotWorkflowDefinition): BotWorkflowDefinition {
    const now = Date.now();
    const existingIdx = this.state.workflows.findIndex((w) => w.id === workflow.id);
    const item: BotWorkflowDefinition = {
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

  delete(id: string): boolean {
    const before = this.state.workflows.length;
    this.state.workflows = this.state.workflows.filter((w) => w.id !== id);
    if (this.state.workflows.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }
}
