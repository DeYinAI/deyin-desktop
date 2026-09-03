import { isPathInsideRoot, logicalResolve, mapPosixOntoWslUnc } from "@deyin/host-core/shared";

/** Common source/config extensions for inline backtick file refs in assistant text. */
const FILE_EXT =
  /\.(?:py|ts|tsx|js|jsx|mjs|cjs|json|txt|md|mdc|yaml|yml|toml|rs|go|java|kt|rb|php|sh|bash|zsh|sql|css|scss|html|xml|svg|vue|svelte|env|gitignore|dockerignore|lock|csv|ini|cfg|conf|log|proto|graphql|wasm|exe|dll|so|dylib)$/i;

/** True when inline code text looks like a workspace file or directory path. */
export function looksLikeFilePath(text: string): boolean {
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  if (/^https?:\/\//i.test(t) || /^mailto:/i.test(t)) return false;
  if (t.endsWith("/") || t.endsWith("\\")) return true;
  if (/[/\\]/.test(t)) return true;
  if (FILE_EXT.test(t)) return true;
  if (/^\.[\w.-]+$/.test(t)) return true;
  return false;
}

/** Normalize display labels (`~`, `host:/path`) into a path root for resolution. */
export function normalizeWorkspaceRootForPaths(workspaceRoot: string, homeDir?: string | null): string {
  let root = workspaceRoot.replace(/[\\/]+$/, "");
  if (homeDir) {
    const home = homeDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (root === "~") return home;
    if (root.startsWith("~/")) return logicalResolve(home, root.slice(2));
  }
  // SSH display label `host:/remote/path` — not a Windows drive letter.
  const remote = /^[^/\\]+:(\/.*|\\.*)$/.exec(root);
  if (remote && !/^[a-zA-Z]:/.test(root)) {
    return remote[1]!.replace(/\\/g, "/");
  }
  return root;
}

/** Resolve a chat/file reference against the workspace root when relative. */
export function resolveWorkspaceFilePath(
  workspaceRoot: string | null,
  file: string,
  homeDir?: string | null,
): string {
  const trimmed = file.trim();
  if (!trimmed) return trimmed;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    const absolute = logicalResolve(trimmed);
    if (workspaceRoot) {
      const mapped = mapPosixOntoWslUnc(workspaceRoot, absolute);
      if (mapped) return mapped;
    }
    return absolute;
  }
  if (!workspaceRoot) return trimmed;
  const root = normalizeWorkspaceRootForPaths(workspaceRoot, homeDir);
  const resolved = logicalResolve(root, trimmed.replace(/^[/\\]+/, ""));
  if (!isPathInsideRoot(root, resolved)) return trimmed;
  const mapped = mapPosixOntoWslUnc(workspaceRoot, resolved);
  return mapped ?? resolved;
}
