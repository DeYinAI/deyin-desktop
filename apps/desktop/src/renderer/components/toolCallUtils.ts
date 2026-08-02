import type { ThreadEvent } from "../threads.js";

/** Research tools collapsed into quiet mode when completed successfully. */
export const QUIET_TOOL_NAMES = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "list_dir",
  "websearch",
  "web_search",
  "codebase_search",
]);

export function isQuietTool(name: string, ok?: boolean, denied?: boolean): boolean {
  if (ok !== true || denied) return false;
  const base = name.toLowerCase().replace(/^mcp_/, "");
  return QUIET_TOOL_NAMES.has(base) || QUIET_TOOL_NAMES.has(name);
}

export function isSubagentTool(name: string): boolean {
  const n = name.toLowerCase();
  return n === "task" || n === "fleet" || n === "parallel_tasks" || n === "parallel-tasks";
}

/** @internal Count DOM-equivalent nodes for perf tests (quiet mode grouping). */
export function countRenderedToolNodes(events: ThreadEvent[]): number {
  const tools = events.filter((e) => e.kind === "tool");
  const quiet = tools.filter((e) => e.kind === "tool" && isQuietTool(e.name, e.ok, e.denied));
  return tools.length - quiet.length + (quiet.length > 0 ? 1 : 0);
}

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "");
}

export function truncateToolCard(text: string, max: number): string {
  return text.length > max ? `… (truncated)\n${text.slice(-max)}` : text;
}

export function toolDisplayName(name: string): string {
  if (name === "bash" && typeof navigator !== "undefined" && /win/i.test(navigator.platform)) {
    return "cmd";
  }
  return name;
}
