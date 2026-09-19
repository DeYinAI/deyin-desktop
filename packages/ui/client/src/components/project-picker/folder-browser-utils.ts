import type { DirectoryEntry } from "@deyin/contract";

const WSL_UNC_RE = /^(?:\\\\|\/\/)wsl(?:\$|\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i;
const WIN_DRIVE_RE = /^([a-zA-Z]:)(?:[\\/](.*))?$/;
const GENERAL_UNC_RE = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/;

/** Split a path into breadcrumb segments for the folder browser. */
export function breadcrumbSegments(path: string): { label: string; path: string }[] {
  if (!path) return [{ label: "/", path: "/" }];

  // 1. WSL UNC path: \\wsl.localhost\<distro>\... or //wsl.localhost/<distro>/...
  const wslMatch = WSL_UNC_RE.exec(path);
  if (wslMatch) {
    const distro = wslMatch[1]!;
    const prefix = `//wsl.localhost/${distro}`;
    const remainder = (wslMatch[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    const crumbs: { label: string; path: string }[] = [{ label: distro, path: prefix }];
    if (!remainder) return crumbs;

    const parts = remainder.split("/").filter(Boolean);
    let acc = prefix;
    for (const part of parts) {
      acc = `${acc}/${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }

  // 2. Windows drive path: C:\... or C:/...
  const driveMatch = WIN_DRIVE_RE.exec(path);
  if (driveMatch) {
    const drive = driveMatch[1]!;
    const prefix = `${drive}/`;
    const remainder = (driveMatch[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    const crumbs: { label: string; path: string }[] = [{ label: drive, path: prefix }];
    if (!remainder) return crumbs;

    const parts = remainder.split("/").filter(Boolean);
    let acc = drive;
    for (const part of parts) {
      acc = `${acc}/${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }

  // 3. General UNC path: \\server\share\... or //server/share/...
  const uncMatch = GENERAL_UNC_RE.exec(path);
  if (uncMatch) {
    const server = uncMatch[1]!;
    const share = uncMatch[2]!;
    const prefix = `//${server}/${share}`;
    const remainder = (uncMatch[3] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    const crumbs: { label: string; path: string }[] = [{ label: `${server}/${share}`, path: prefix }];
    if (!remainder) return crumbs;

    const parts = remainder.split("/").filter(Boolean);
    let acc = prefix;
    for (const part of parts) {
      acc = `${acc}/${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }

  // 4. POSIX path: /...
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
  if (!path) return null;

  // 1. WSL UNC path
  const wslMatch = WSL_UNC_RE.exec(path);
  if (wslMatch) {
    const distro = wslMatch[1]!;
    const remainder = (wslMatch[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!remainder) return null;
    const idx = remainder.lastIndexOf("/");
    return idx <= 0 ? `//wsl.localhost/${distro}` : `//wsl.localhost/${distro}/${remainder.slice(0, idx)}`;
  }

  // 2. Windows drive path
  const driveMatch = WIN_DRIVE_RE.exec(path);
  if (driveMatch) {
    const drive = driveMatch[1]!;
    const remainder = (driveMatch[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!remainder) return null;
    const idx = remainder.lastIndexOf("/");
    return idx <= 0 ? `${drive}/` : `${drive}/${remainder.slice(0, idx)}`;
  }

  // 3. General UNC path
  const uncMatch = GENERAL_UNC_RE.exec(path);
  if (uncMatch) {
    const server = uncMatch[1]!;
    const share = uncMatch[2]!;
    const remainder = (uncMatch[3] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!remainder) return null;
    const idx = remainder.lastIndexOf("/");
    return idx <= 0 ? `//${server}/${share}` : `//${server}/${share}/${remainder.slice(0, idx)}`;
  }

  // 4. POSIX path
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
