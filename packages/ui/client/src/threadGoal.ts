import type { Project, Thread, ThreadEvent, ThreadGoal } from "@deyin/host-core/shared";
import { DEFAULT_MAX_GOAL_ROUNDS } from "@deyin/agent-core/goal-constants";
import { goalPatchFromCommand } from "./goal-command.js";
import { newId } from "./threads.js";

/** A new objective on a thread whose goal is still unfinished replaces it ("Goal updated"). */
export function isReplacingGoal(existing: ThreadGoal | undefined): boolean {
  return existing !== undefined && existing.status !== "met" && existing.status !== "done";
}

export interface GoalApplyOptions {
  /** Goal fields to store, when the caller already created them (so it can start a run with the same id). */
  armed?: ThreadGoal;
  /** Skip the "Goal set" timeline note; the caller appends it where it wants it. */
  recordEvent?: boolean;
}

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
  options: GoalApplyOptions = {},
): GoalProjectsUpsertResult {
  // A new goal gets a fresh instance id and the loop's round budget, so the UI
  // can show `rounds/maxRounds` and a stale continuation from a replaced goal
  // cannot be applied to this one.
  const patch =
    goal !== null && options.armed
      ? { goal: options.armed }
      : goalPatchFromCommand(goal, {
          id: goal === null ? undefined : newId("goal"),
          maxRounds: DEFAULT_MAX_GOAL_ROUNDS,
        });
  const previous = projects.flatMap((p) => p.threads).find((t) => t.id === thread.id)?.goal;
  const goalEvent: ThreadEvent =
    goal !== null && isReplacingGoal(previous)
      ? { kind: "goal-set", text: goal, replaced: true }
      : { kind: "goal-set", text: goal };
  const recordEvent = options.recordEvent ?? true;
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
        ? { ...t, ...patch, events: recordEvent ? [...t.events, goalEvent] : t.events, updatedAt: Date.now() }
        : t,
    ),
  }));

  return { projects: next, createdProjectId };
}
