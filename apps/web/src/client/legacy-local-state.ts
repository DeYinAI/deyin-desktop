/**
 * Readers for the web client's localStorage state that also upgrade what an older
 * build saved. They take the store as a parameter (the transport passes
 * `localStorage`) so the upgrade rules can be tested without a browser.
 */
import { migrateProjectsState } from "@deyin/host-core/shared";
import type { ConductorWorkflowDefinition, ProjectsState } from "@deyin/host-core/shared";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PROJECTS_KEY = "deyin.projects";
export const CONDUCTOR_WORKFLOWS_KEY = "deyin.conductorWorkflows";
/** Where pipelines were kept before Conductor's ids left "bot"; read only until the new key exists. */
export const LEGACY_CONDUCTOR_WORKFLOWS_KEY = "deyin.botWorkflows";

export const EMPTY_PROJECTS: ProjectsState = {
  projects: [],
  activeProjectId: null,
  activeThreadId: null,
  workspaceRoot: null,
};

function readJson(store: KeyValueStore, key: string): unknown {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    // Storage unavailable or the blob is corrupt: treated as absent, never thrown at the UI.
    return undefined;
  }
}

/**
 * The saved projects. Threads from before Conductor's ids left "bot" are upgraded and
 * written back once, so the next read is already current.
 */
export function readProjects(store: KeyValueStore): ProjectsState {
  const saved = readJson(store, PROJECTS_KEY);
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return EMPTY_PROJECTS;
  const { state, changed } = migrateProjectsState({ ...EMPTY_PROJECTS, ...(saved as Partial<ProjectsState>) });
  if (changed) {
    try {
      store.setItem(PROJECTS_KEY, JSON.stringify(state));
    } catch {
      // Quota or privacy mode: the upgraded state is still returned; it just is not cached.
    }
  }
  return state;
}

/** Saved Conductor pipelines, falling back to the legacy key until the first save under the new one. */
export function readConductorWorkflows(store: KeyValueStore): ConductorWorkflowDefinition[] {
  let key = CONDUCTOR_WORKFLOWS_KEY;
  try {
    // Presence, not content: an empty list under the new key means "all deleted", and must
    // not bring the legacy copy back.
    if (store.getItem(CONDUCTOR_WORKFLOWS_KEY) === null) key = LEGACY_CONDUCTOR_WORKFLOWS_KEY;
  } catch {
    return [];
  }
  const saved = readJson(store, key);
  return Array.isArray(saved) ? (saved as ConductorWorkflowDefinition[]) : [];
}
