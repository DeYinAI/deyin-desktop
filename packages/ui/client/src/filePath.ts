import { isPathInsideRoot, logicalResolve } from "@deyin/host-core/shared";

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

/** Resolve a chat/file reference against the workspace root when relative. */
export function resolveWorkspaceFilePath(workspaceRoot: string | null, file: string): string {
  const trimmed = file.trim();
  if (!trimmed) return trimmed;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    return logicalResolve(trimmed);
  }
  if (!workspaceRoot) return trimmed;
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const resolved = logicalResolve(root, trimmed.replace(/^[/\\]+/, ""));
  if (!isPathInsideRoot(root, resolved)) return trimmed;
  return resolved;
}
