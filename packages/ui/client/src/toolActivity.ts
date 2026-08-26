type ToolEvent = Extract<import("@deyin/host-core/shared").ThreadEvent, { kind: "tool" }>;
type FileEvent = Extract<import("@deyin/host-core/shared").ThreadEvent, { kind: "file" }>;

const EDIT_TOOLS = new Set(["write", "edit", "notebook_edit"]);
const SHELL_TOOLS = new Set(["bash"]);
const READ_TOOLS = new Set(["read", "glob", "ls", "file_tree"]);
const SEARCH_TOOLS = new Set(["grep", "codebase_search", "websearch", "web_search", "web_fetch"]);

export type ToolActivityIcon = "terminal" | "pencil" | "search" | "bolt" | "brain";

export interface ToolActivitySummary {
  label: string;
  icon: ToolActivityIcon;
  overflow: number;
  running: boolean;
  failed: boolean;
}

function countCategories(events: ToolEvent[]): {
  edit: number;
  shell: number;
  reads: number;
  searches: number;
  other: number;
} {
  const counts = { edit: 0, shell: 0, reads: 0, searches: 0, other: 0 };
  for (const event of events) {
    if (EDIT_TOOLS.has(event.name)) counts.edit += 1;
    else if (SHELL_TOOLS.has(event.name)) counts.shell += 1;
    else if (READ_TOOLS.has(event.name)) counts.reads += 1;
    else if (SEARCH_TOOLS.has(event.name)) counts.searches += 1;
    else counts.other += 1;
  }
  return counts;
}

function pickIcon(counts: ReturnType<typeof countCategories>): ToolActivityIcon {
  if (counts.shell > 0) return "terminal";
  if (counts.edit > 0) return "pencil";
  if (counts.reads > 0 || counts.searches > 0) return "search";
  return "bolt";
}

/** "Explored 3 files, 2 searches" — reads and searches never change tense. */
function exploreLabel(counts: ReturnType<typeof countCategories>): string | null {
  const parts: string[] = [];
  if (counts.reads > 0) {
    parts.push(counts.reads === 1 ? "Explored 1 file" : `Explored ${counts.reads} files`);
  }
  if (counts.searches > 0) {
    parts.push(counts.searches === 1 ? "1 search" : `${counts.searches} searches`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function diffSuffix(files: FileEvent[]): string {
  const adds = files.reduce((sum, file) => sum + file.adds, 0);
  const dels = files.reduce((sum, file) => sum + file.dels, 0);
  if (adds === 0 && dels === 0) return "";
  return ` +${adds} -${dels}`;
}

/** Cursor-style one-line label for a block of tool calls in chat. */
export function summarizeToolActivity(events: ToolEvent[], files: FileEvent[] = []): ToolActivitySummary {
  const counts = countCategories(events);
  const running = events.some((e) => e.ok === undefined);
  const failed = events.some((e) => e.ok === false || e.denied);
  const parts: string[] = [];

  if (counts.edit > 0) {
    parts.push(
      running
        ? counts.edit === 1
          ? "Editing 1 file"
          : `Editing ${counts.edit} files`
        : counts.edit === 1
          ? "Edited 1 file"
          : `Edited ${counts.edit} files`,
    );
  }

  const explore = exploreLabel(counts);
  if (explore) parts.push(explore);

  const overflow = counts.shell + counts.other;
  if (running) {
    if (counts.shell > 0 && parts.length === 0) parts.push("Running commands");
    if (parts.length === 0 && counts.other > 0) parts.push(`Running ${counts.other} tools`);
    return {
      label: (parts.join(", ") || "Working…") + diffSuffix(files),
      icon: pickIcon(counts),
      overflow,
      running: true,
      failed,
    };
  }

  if (counts.shell > 0) parts.push(counts.shell === 1 ? "Ran command" : "Ran commands");
  if (counts.other > 0) parts.push(counts.other === 1 ? "Ran 1 tool" : `Ran ${counts.other} tools`);

  return {
    label: (parts.join(", ") || "Worked on it") + diffSuffix(files),
    icon: pickIcon(counts),
    overflow: 0,
    running: false,
    failed,
  };
}

type ReasoningEvent = Extract<import("@deyin/host-core/shared").ThreadEvent, { kind: "reasoning" }>;

/** One collapsed timeline row for a block of reasoning + tool + file events. */
export function summarizeActivityBlock(
  tools: ToolEvent[],
  files: FileEvent[],
  reasonings: ReasoningEvent[],
): ToolActivitySummary {
  if (tools.length === 0 && files.length === 0) {
    const seconds = reasonings.reduce((sum, event) => sum + (event.seconds ?? 0), 0);
    return {
      label: seconds > 0 ? `Thought · ${seconds}s` : "Thought",
      icon: "brain",
      overflow: 0,
      running: false,
      failed: false,
    };
  }
  return summarizeToolActivity(tools, files);
}
