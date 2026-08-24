import type { Project, WorkspaceLocation } from "./types.js";

/** Stable key for deduplicating workspace locations. */
export function locationKey(loc: WorkspaceLocation): string {
  switch (loc.kind) {
    case "local":
      return `local:${normalizePath(loc.root)}`;
    case "remote":
      return `remote:${loc.hostId}:${normalizePath(loc.root)}`;
    default: {
      const _exhaustive: never = loc;
      return String(_exhaustive);
    }
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Display path with `~` when under homeDir. */
export function displayLocationPath(loc: WorkspaceLocation, homeDir?: string | null): string {
  if (loc.kind === "remote") return loc.root;
  return shortenHome(loc.root, homeDir);
}

export function shortenHome(root: string, homeDir?: string | null): string {
  const normalized = root.replace(/\\/g, "/");
  const home = homeDir?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (home && (normalized === home || normalized.startsWith(`${home}/`))) {
    return `~${normalized.slice(home.length)}`;
  }
  return normalized;
}

/** Resolve a project's location, falling back to `root` for legacy entries. */
export function projectLocation(project: Project): WorkspaceLocation | null {
  if (project.location) return project.location;
  if (project.root) return { kind: "local", root: project.root };
  return null;
}

/** Mark a project opened now; returns updated project list (immutable). */
export function touchProjectOpened(projects: Project[], projectId: string): Project[] {
  const now = new Date().toISOString();
  return projects.map((p) => (p.id === projectId ? { ...p, lastOpenedAt: now } : p));
}

/** Top N folder-backed projects sorted by most recently opened. */
export function recentProjects(projects: Project[], limit = 10): Project[] {
  return projects
    .filter((p) => projectLocation(p) !== null)
    .slice()
    .sort((a, b) => {
      const ta = a.lastOpenedAt ?? "";
      const tb = b.lastOpenedAt ?? "";
      return tb.localeCompare(ta);
    })
    .slice(0, limit);
}

/** Fuzzy match recents against a search query. */
export function filterRecentProjects(projects: Project[], query: string, homeDir?: string | null): Project[] {
  const q = query.trim().toLowerCase();
  const recents = recentProjects(projects, 20);
  if (!q) return recents.slice(0, 10);
  return recents.filter((p) => {
    const loc = projectLocation(p);
    if (!loc) return false;
    const label = `${p.name} ${displayLocationPath(loc, homeDir)}`.toLowerCase();
    return label.includes(q);
  });
}
