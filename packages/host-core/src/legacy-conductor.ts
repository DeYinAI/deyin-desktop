/**
 * Upgrades for state saved while Conductor's internal ids were still "bot".
 *
 * Deyin has two products that could both be called "bot": Conductor (a pipeline of
 * external coding CLIs) and Deyin Bot (a durable persona with its own memory and
 * routines). Conductor's ids moved to "conductor" so "bot" means one thing. Anything
 * persisted under the old ids is mapped here, in one browser-safe module, so the
 * desktop's projects.json and the web client's localStorage upgrade the same way.
 */
import type { Project, ProjectsState, Thread, ThreadEvent } from "./types.js";

/** Model-facing tool names Conductor used to register, mapped to their current names. */
export const LEGACY_CONDUCTOR_TOOL_NAMES: Readonly<Record<string, string>> = {
  bot_workflow_validate: "conductor_workflow_validate",
  bot_workflow_run: "conductor_workflow_run",
  inspect_bot_run: "inspect_conductor_run",
  merge_bot_diff: "merge_conductor_diff",
};

/** The current name for a tool name read from saved history; unknown names pass through. */
export function legacyConductorToolName(name: string): string {
  return Object.hasOwn(LEGACY_CONDUCTOR_TOOL_NAMES, name) ? LEGACY_CONDUCTOR_TOOL_NAMES[name]! : name;
}

/** Saved modes are untrusted: they predate the rename, so "bot" may still be on disk. */
function currentMode<T>(mode: T): T | "conductor" {
  return (mode as unknown) === "bot" ? "conductor" : mode;
}

function migrateEvent(event: ThreadEvent): ThreadEvent {
  if (event.kind !== "tool") return event;
  const name = legacyConductorToolName(event.name);
  return name === event.name ? event : { ...event, name };
}

function migrateThread(thread: Thread): Thread {
  const mode = currentMode(thread.mode);
  const previousMode = currentMode(thread.previousMode);
  const events = Array.isArray(thread.events) ? thread.events : [];
  const migratedEvents = events.map(migrateEvent);
  const eventsChanged = migratedEvents.some((event, index) => event !== events[index]);
  if (mode === thread.mode && previousMode === thread.previousMode && !eventsChanged) return thread;
  const next: Thread = { ...thread, events: eventsChanged ? migratedEvents : thread.events };
  if (thread.mode !== undefined) next.mode = mode;
  if (thread.previousMode !== undefined) next.previousMode = previousMode;
  return next;
}

function migrateProject(project: Project): Project {
  if (!Array.isArray(project.threads)) return project;
  const threads = project.threads.map(migrateThread);
  return threads.some((thread, index) => thread !== project.threads[index]) ? { ...project, threads } : project;
}

/**
 * Rewrite legacy Conductor ids in a saved projects state: thread `mode` / `previousMode`
 * "bot" becomes "conductor", and tool events keep rendering under their new names.
 *
 * Pure: the input is never mutated, and a state with nothing to upgrade is returned
 * as-is (same reference) with `changed: false`, so callers only write back when needed.
 */
export function migrateProjectsState(state: ProjectsState): { state: ProjectsState; changed: boolean } {
  if (!state || !Array.isArray(state.projects)) return { state, changed: false };
  const projects = state.projects.map(migrateProject);
  const changed = projects.some((project, index) => project !== state.projects[index]);
  return changed ? { state: { ...state, projects }, changed } : { state, changed };
}
