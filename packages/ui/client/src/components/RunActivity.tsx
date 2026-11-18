import { useEffect, useState, type ReactNode } from "react";
import type { ThreadEvent } from "../threads.js";
import { Icon, type IconName } from "./Icon.js";

/** The event kinds an agent run is made of. */
export type ActivityItem = Extract<ThreadEvent, { kind: "tool" | "file" | "reasoning" }>;

type RowStatus = "running" | "ok" | "failed";

interface RunRow {
  item: ActivityItem;
  icon: IconName;
  label: string;
  detail: string;
  status: RowStatus;
}

interface ToolLook {
  icon: IconName;
  label: string;
}

const TOOL_LOOKS: Record<string, ToolLook> = {
  bash: { icon: "terminal", label: "Bash" },
  read: { icon: "file", label: "Read" },
  write: { icon: "pencil", label: "Write" },
  edit: { icon: "pencil", label: "Edit" },
  notebook_edit: { icon: "pencil", label: "Edit" },
  glob: { icon: "search", label: "Glob" },
  grep: { icon: "search", label: "Grep" },
  ls: { icon: "folder", label: "List" },
  file_tree: { icon: "folder", label: "Tree" },
  codebase_search: { icon: "search", label: "Search" },
  websearch: { icon: "globe", label: "Search" },
  web_search: { icon: "globe", label: "Search" },
  web_fetch: { icon: "globe", label: "Fetch" },
  task: { icon: "bot", label: "Agent" },
};

function toolLook(name: string): ToolLook {
  const known = TOOL_LOOKS[name];
  if (known) return known;
  const pretty = name.replace(/[_-]+/g, " ").trim();
  return { icon: "bolt", label: pretty.charAt(0).toUpperCase() + pretty.slice(1) };
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toRow(item: ActivityItem): RunRow {
  switch (item.kind) {
    case "tool": {
      const look = toolLook(item.name);
      const status: RowStatus = item.ok === undefined ? "running" : item.ok && !item.denied ? "ok" : "failed";
      return { item, icon: look.icon, label: look.label, detail: firstLine(item.summary, 200), status };
    }
    case "file":
      return {
        item,
        icon: "pencil",
        label: "Edit",
        detail: `${item.name}${item.adds || item.dels ? `  +${item.adds} −${item.dels}` : ""}`,
        status: "ok",
      };
    case "reasoning":
      return { item, icon: "brain", label: "Think", detail: firstLine(item.text, 220), status: "ok" };
    default: {
      const unreachable: never = item;
      return unreachable;
    }
  }
}

/** Wall-clock time the block took: tool durations plus reasoning time. */
function blockDurationMs(items: ActivityItem[]): number {
  let total = 0;
  for (const item of items) {
    if (item.kind === "tool") total += item.durationMs ?? 0;
    else if (item.kind === "reasoning") total += (item.seconds ?? 0) * 1000;
  }
  return total;
}

export function formatRunDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const SHELL = new Set(["bash"]);
const EDITS = new Set(["write", "edit", "notebook_edit"]);
const WEB = new Set(["websearch", "web_search", "web_fetch"]);
const EXPLORE = new Set(["read", "glob", "grep", "ls", "file_tree", "codebase_search"]);

/** "Ran commands, wrote files, visited web pages, etc." — what kinds of work the block did. */
export function describeRunWork(items: ActivityItem[]): string {
  const phrases: string[] = [];
  const add = (phrase: string) => {
    if (!phrases.includes(phrase)) phrases.push(phrase);
  };
  for (const item of items) {
    if (item.kind === "file") add("wrote files");
    else if (item.kind === "tool") {
      if (SHELL.has(item.name)) add("ran commands");
      else if (EDITS.has(item.name)) add("wrote files");
      else if (WEB.has(item.name)) add("visited web pages");
      else if (EXPLORE.has(item.name)) add("explored files");
      else add("used tools");
    }
  }
  if (phrases.length === 0) return "Thought it through";
  const shown = phrases.slice(0, 3);
  const text = shown.join(", ") + (phrases.length > shown.length ? ", etc." : "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface RunActivityProps {
  /** Consecutive reasoning/tool/file events, in the order they happened. */
  items: ActivityItem[];
  /** The run is still producing this block. */
  live: boolean;
  /** Expanded detail for one step (command output, diff, reasoning text). */
  renderDetail: (item: ActivityItem) => ReactNode;
}

/** One block of agent steps as a fold: a "Completed in …" rule, then a compact list
 *  of one-line steps (Label · detail) that each expand to their full card. */
export function RunActivity(props: RunActivityProps) {
  const { items, live } = props;
  const [open, setOpen] = useState(live);
  const [subOpen, setSubOpen] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());

  // Follow the run while it streams, then fold the finished block away.
  useEffect(() => {
    setOpen(live);
  }, [live]);

  const rows = items.map(toRow);
  const failed = rows.some((r) => r.status === "failed");
  const duration = blockDurationMs(items);
  const headLabel = live
    ? "Working…"
    : duration > 0
      ? `Completed in ${formatRunDuration(duration)}`
      : failed
        ? "Finished with errors"
        : "Completed";

  const toggleRow = (index: number) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className={`run${live ? " run--live" : ""}`}>
      <button type="button" className="run__head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="run__head-label">{headLabel}</span>
        <Icon name="chevronDown" size={12} className={`run__chev${open ? " run__chev--open" : ""}`} />
      </button>
      {open && (
        <>
          <button type="button" className="run__sub" aria-expanded={subOpen} onClick={() => setSubOpen((v) => !v)}>
            <Icon name="chevronDown" size={12} className={`run__chev${subOpen ? " run__chev--open" : ""}`} />
            <span>{describeRunWork(items)}</span>
          </button>
          {subOpen && (
            <ul className="run__steps">
              {rows.map((row, i) => {
                const isOpen = expanded.has(i);
                return (
                  <li key={i} className={`run-step run-step--${row.status}`}>
                    <button
                      type="button"
                      className="run-step__row"
                      aria-expanded={isOpen}
                      onClick={() => toggleRow(i)}
                    >
                      <Icon
                        name={row.status === "running" ? "refresh" : row.icon}
                        size={13}
                        className={`run-step__icon${row.status === "running" ? " run-step__icon--spin" : ""}`}
                      />
                      <span className="run-step__label">{row.label}</span>
                      {row.detail && (
                        <>
                          <span className="run-step__dot" aria-hidden />
                          <span className="run-step__detail">{row.detail}</span>
                        </>
                      )}
                    </button>
                    {isOpen && <div className="run-step__body">{props.renderDetail(row.item)}</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
