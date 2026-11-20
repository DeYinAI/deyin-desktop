import type { Project, Thread } from "../types.js";

/**
 * Bot conversations live in one reserved, folder-less project. They are not part of any repository:
 * removing a workspace must not delete a Bot's chats, Code's lists must not show them, and opening one
 * must not change the workspace root.
 */
export const BOTS_PROJECT_ID = "__bots__";
export const BOTS_PROJECT_NAME = "Deyin Bot";

export function isBotsProject(project: Pick<Project, "id">): boolean {
  return project.id === BOTS_PROJECT_ID;
}

/** The projects Deyin Code and Conductor show: everything except the Bots project. */
export function visibleProjects<P extends Pick<Project, "id">>(projects: readonly P[]): P[] {
  return projects.filter((project) => !isBotsProject(project));
}

/** A Bot's conversations, newest first, archived ones left out. */
export function botThreads(projects: readonly Project[], botId: string): Thread[] {
  const bots = projects.find(isBotsProject);
  if (!bots) return [];
  return bots.threads.filter((thread) => thread.botId === botId && !thread.archived).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Put a new Bot conversation first in the Bots project, creating the project (last, so the first
 * workspace stays first) when it does not exist yet. A thread without a `botId` is refused so a Code
 * conversation can never end up where the Bots-only rules would hide it.
 */
export function addBotThread(projects: readonly Project[], thread: Thread): Project[] {
  if (!thread.botId) throw new Error("A Bot conversation needs a botId.");
  // The project's id is the one `isBotsProject` looks for. It is not a choice: any other id would make a project
  // that Code lists and that no Bot can find its conversations in.
  if (!projects.some(isBotsProject)) {
    return [...projects, { id: BOTS_PROJECT_ID, name: BOTS_PROJECT_NAME, root: null, threads: [thread] }];
  }
  return projects.map((project) => (isBotsProject(project) ? { ...project, threads: [thread, ...project.threads] } : project));
}

/** Drop every conversation of a deleted Bot. Returns the same array when there was nothing to drop. */
export function removeBotThreads(projects: readonly Project[], botId: string): Project[] {
  let changed = false;
  const next = projects.map((project) => {
    if (!isBotsProject(project)) return project;
    const kept = project.threads.filter((thread) => thread.botId !== botId);
    if (kept.length === project.threads.length) return project;
    changed = true;
    return { ...project, threads: kept };
  });
  return changed ? next : (projects as Project[]);
}
