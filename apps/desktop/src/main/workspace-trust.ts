import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Workspace trust (VS Code-style): a cloned repository's `.deyin/mcp.json` and
 * `.deyin/hooks.json` can define arbitrary shell commands. They only execute
 * after the user has explicitly trusted that workspace folder once.
 */
export interface WorkspaceTrust {
  isTrusted(root: string): boolean;
  trust(root: string): void;
}

/** Does this workspace ship Deyin execution artifacts (hooks / MCP commands)? */
export function workspaceHasDeyinArtifacts(root: string | null): boolean {
  if (!root) return false;
  return (
    existsSync(join(root, ".deyin", "hooks.json")) || existsSync(join(root, ".deyin", "mcp.json"))
  );
}

/** Persisted set of trusted workspace roots, backed by the storage layer. */
export class WorkspaceTrustStore implements WorkspaceTrust {
  private roots: Set<string>;

  constructor(
    read: () => string[],
    private readonly persist: (roots: string[]) => void,
  ) {
    this.roots = new Set(read().filter((r) => typeof r === "string" && r.length > 0));
  }

  isTrusted(root: string): boolean {
    return this.roots.has(root);
  }

  trust(root: string): void {
    if (this.roots.has(root)) return;
    this.roots.add(root);
    this.persist([...this.roots]);
  }
}
