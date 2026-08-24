import type { DirectoryEntry } from "@deyin/contract";

/** Split a path into breadcrumb segments for the folder browser. */
export function breadcrumbSegments(path: string): { label: string; path: string }[] {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (normalized === "/") return [{ label: "/", path: "/" }];
  const parts = normalized.split("/").filter(Boolean);
  const crumbs: { label: string; path: string }[] = [];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : `/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/** Filter directory entries by case-insensitive substring. */
export function filterDirectoryEntries(entries: DirectoryEntry[], query: string): DirectoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.filter((e) => e.kind === "directory");
  return entries.filter((e) => e.kind === "directory" && e.name.toLowerCase().includes(q));
}

/** Parent path for navigating up one level. */
export function parentPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized === "/") return null;
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "/" : normalized.slice(0, idx);
}

/** WSL UNC root for a distro. */
export function wslBrowseRoot(distro: string): string {
  return `\\\\wsl.localhost\\${distro}\\home`;
}

export function wslEnvLabel(distro: string): string {
  return distro;
}
