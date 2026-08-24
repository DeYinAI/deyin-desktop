type ToolEvent = Extract<import("@deyin/host-core/shared").ThreadEvent, { kind: "tool" }>;

const EDIT_TOOLS = new Set(["write", "edit", "notebook_edit"]);
const SHELL_TOOLS = new Set(["bash"]);
const EXPLORE_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "websearch",
  "web_search",
  "web_fetch",
  "codebase_search",
  "file_tree",
]);

export type ToolActivityIcon = "terminal" | "pencil" | "search" | "bolt";

export interface ToolActivitySummary {
  label: string;
  icon: ToolActivityIcon;
  overflow: number;
  running: boolean;
  failed: boolean;
}

function countCategories(events: ToolEvent[]): { edit: number; shell: number; explore: number; other: number } {
  const counts = { edit: 0, shell: 0, explore: 0, other: 0 };
  for (const event of events) {
    if (EDIT_TOOLS.has(event.name)) counts.edit += 1;
    else if (SHELL_TOOLS.has(event.name)) counts.shell += 1;
    else if (EXPLORE_TOOLS.has(event.name)) counts.explore += 1;
    else counts.other += 1;
  }
  return counts;
}

function pickIcon(counts: ReturnType<typeof countCategories>): ToolActivityIcon {
  if (counts.shell > 0) return "terminal";
  if (counts.edit > 0) return "pencil";
  if (counts.explore > 0) return "search";
  return "bolt";
}

/** Cursor-style one-line label for a block of tool calls in chat. */
export function summarizeToolActivity(events: ToolEvent[]): ToolActivitySummary {
  const counts = countCategories(events);
  const running = events.some((e) => e.ok === undefined);
  const failed = events.some((e) => e.ok === false || e.denied);

  if (running) {
    const parts: string[] = [];
    if (counts.edit > 0) {
      parts.push(counts.edit === 1 ? "Editing 1 file" : `Editing ${counts.edit} files`);
    }
    if (counts.explore > 0) {
      parts.push(counts.explore === 1 ? "Explored 1 file" : `Explored ${counts.explore} files`);
    }
    const overflow = counts.shell + counts.other;
    if (counts.shell > 0 && overflow === 0) parts.push("Running commands");
    if (parts.length === 0 && counts.shell > 0) parts.push("Running commands");
    if (parts.length === 0 && counts.other > 0) parts.push(`Running ${counts.other} tools`);
    return {
      label: parts.join(", ") || "Working…",
      icon: pickIcon(counts),
      overflow,
      running: true,
      failed,
    };
  }

  const parts: string[] = [];
  if (counts.edit > 0) parts.push(counts.edit === 1 ? "Edited 1 file" : "Edited files");
  if (counts.explore > 0) parts.push(counts.explore === 1 ? "Explored 1 file" : "Explored files");
  if (counts.shell > 0) parts.push(counts.shell === 1 ? "Ran command" : "Ran commands");
  if (counts.other > 0) parts.push(counts.other === 1 ? "Ran 1 tool" : `Ran ${counts.other} tools`);

  return {
    label: parts.join(", ") || "Worked on it",
    icon: pickIcon(counts),
    overflow: 0,
    running: false,
    failed,
  };
}
