import type { Project, Thread, ThreadEvent } from "@deyin/host-core/shared";
import { goalPatchFromCommand } from "./goal-command.js";
import { newId } from "./threads.js";

export interface GoalProjectsUpsertResult {
  projects: Project[];
  /** Set when a new project row is created for the thread. */
  createdProjectId?: string;
}

/** Insert `thread` when missing, then apply goal + timeline note in one pass.
 *  Avoids the new-chat race where ensureThread + updateThread + appendEvents
 *  were separate setProjects calls and the goal could be lost. */
export function applyGoalToProjects(
  projects: Project[],
  thread: Thread,
  goal: string | null,
  activeProjectId: string | null,
  defaultProjectName = "Workspace",
): GoalProjectsUpsertResult {
  const patch = goalPatchFromCommand(goal);
  const goalEvent: ThreadEvent = { kind: "goal-set", text: goal };
  let next = projects;
  let createdProjectId: string | undefined;

  const exists = next.some((p) => p.threads.some((t) => t.id === thread.id));
  if (!exists) {
    if (next.length === 0) {
      createdProjectId = newId("proj");
      next = [{ id: createdProjectId, name: defaultProjectName, root: null, threads: [thread] }];
    } else {
      const target = next.some((p) => p.id === activeProjectId) ? activeProjectId! : next[0]!.id;
      next = next.map((p) => (p.id === target ? { ...p, threads: [thread, ...p.threads] } : p));
    }
  }

  next = next.map((project) => ({
    ...project,
    threads: project.threads.map((t) =>
      t.id === thread.id
        ? { ...t, ...patch, events: [...t.events, goalEvent], updatedAt: Date.now() }
        : t,
    ),
  }));

  return { projects: next, createdProjectId };
}
