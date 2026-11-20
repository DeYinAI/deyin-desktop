import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ThreadEvent } from "../threads.js";
import { Icon, type IconName } from "./Icon.js";

/** The event kinds an agent run is made of. */
export type ActivityItem = Extract<ThreadEvent, { kind: "tool" | "file" | "reasoning" }>;

type FileActivity = Extract<ActivityItem, { kind: "file" }>;

type RowStatus = "running" | "ok" | "failed";

export interface RunRow {
  /** What the row stands for: the tool call, or the lone reasoning / file item. */
  item: ActivityItem;
  /** The edit card folded into this row: a Write/Edit call and the file it changed are one step, not two. */
  file?: FileActivity;
  icon: IconName;
  label: string;
  detail: string;
  status: RowStatus;
  /** Loop step (one model request) that produced the row; undefined for runs recorded before steps were stamped. */
  step?: number;
}

/** Rows that came out of the same model request. */
export interface RunGroup {
  step?: number;
  rows: { row: RunRow; index: number }[];
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

const SHELL = new Set(["bash"]);
/** Tools that edit exactly one file, so the file card they produce can be matched back to the call by path. */
const EDITS = new Set(["write", "edit", "notebook_edit"]);
const WEB = new Set(["websearch", "web_search", "web_fetch"]);
const EXPLORE = new Set(["read", "glob", "grep", "ls", "file_tree", "codebase_search"]);

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

function formatEditStats(file: FileActivity): string {
  return file.adds || file.dels ? `+${file.adds} −${file.dels}` : "";
}

function stepOf(item: ActivityItem): { step?: number } {
  return item.step === undefined ? {} : { step: item.step };
}

function toRow(item: ActivityItem): RunRow {
  switch (item.kind) {
    case "tool": {
      const look = toolLook(item.name);
      const status: RowStatus = item.ok === undefined ? "running" : item.ok && !item.denied ? "ok" : "failed";
      return { item, icon: look.icon, label: look.label, detail: firstLine(item.summary, 200), status, ...stepOf(item) };
    }
    case "file":
      return {
        item,
        icon: "pencil",
        label: "Edit",
        detail: `${item.name}${item.adds || item.dels ? `  ${formatEditStats(item)}` : ""}`,
        status: "ok",
        ...stepOf(item),
      };
    case "reasoning":
      return { item, icon: "brain", label: "Think", detail: firstLine(item.text, 220), status: "ok", ...stepOf(item) };
    default: {
      const unreachable: never = item;
      return unreachable;
    }
  }
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** The file an edit tool call targets, out of its one-line summary (`path`, `path (3 edits)`, `notebook path cell 2`). */
function editTargetPath(summary: string): string {
  const notebook = /^notebook (.+) cell \S*$/.exec(summary.trim());
  const path = notebook ? notebook[1]! : summary.replace(/ \(\d+ edits\)$/, "");
  return normalizePath(path);
}

/** The call names the file as the model wrote it (often relative); the card carries the resolved path. */
function targetsFile(summary: string, file: FileActivity): boolean {
  const target = editTargetPath(summary);
  if (!target) return false;
  const full = normalizePath(file.subtitle || file.name);
  return full === target || full.endsWith(`/${target}`);
}

/**
 * The rows of one block of steps. A Write/Edit call and the file card it produced
 * are folded into one row (they used to show twice: "Write src/a.ts" then
 * "Edit a.ts +3 −1"). A file card with no call to pair with — a multi-file patch,
 * or runs from before the two were related — keeps its own row.
 *
 * Pairing is by path, earliest unmatched call first: that is right for both
 * sequential edits (call, card, call, card) and parallel ones (call, call, card,
 * card). A call that failed produced no card, so it is never paired.
 */
export function buildRunRows(items: ActivityItem[]): RunRow[] {
  const rows: RunRow[] = [];
  /** Indexes of edit-tool rows still waiting for their file card. */
  const unpaired: number[] = [];
  for (const item of items) {
    if (item.kind === "file") {
      const at = unpaired.findIndex((rowIndex) => {
        const row = rows[rowIndex]!;
        if (row.item.kind !== "tool" || row.status === "failed") return false;
        if (row.step !== undefined && item.step !== undefined && row.step !== item.step) return false;
        return targetsFile(row.item.summary, item);
      });
      if (at >= 0) {
        const rowIndex = unpaired[at]!;
        unpaired.splice(at, 1);
        const row = rows[rowIndex]!;
        const stats = formatEditStats(item);
        rows[rowIndex] = {
          ...row,
          file: item,
          detail: stats ? `${row.detail}  ${stats}` : row.detail,
        };
        continue;
      }
    }
    if (item.kind === "tool" && EDITS.has(item.name)) unpaired.push(rows.length);
    rows.push(toRow(item));
  }
  return rows;
}

/** Consecutive rows from the same model request. Rows with no step are never grouped. */
export function groupRowsByStep(rows: RunRow[]): RunGroup[] {
  const groups: RunGroup[] = [];
  rows.forEach((row, index) => {
    const last = groups[groups.length - 1];
    if (last && row.step !== undefined && last.step === row.step) last.rows.push({ row, index });
    else groups.push({ ...(row.step === undefined ? {} : { step: row.step }), rows: [{ row, index }] });
  });
  return groups;
}

/** How many distinct model requests the block's rows came from. */
export function countSteps(rows: RunRow[]): number {
  return new Set(rows.flatMap((row) => (row.step === undefined ? [] : [row.step]))).size;
}

/**
 * How long the block took on the clock: from the first item starting to the last
 * one ending. Summing durations (what this used to do) double-counts tools that
 * ran in parallel and leaves out the time the model spent between them.
 *
 * Needs every tool and reasoning item to carry timestamps; blocks recorded before
 * that fall back to the old sum, which is the best a bare duration can give.
 */
export function blockDurationMs(items: ActivityItem[]): number {
  let first = Infinity;
  let last = -Infinity;
  let timed = true;
  let summed = 0;
  for (const item of items) {
    if (item.kind === "tool") {
      summed += item.durationMs ?? 0;
      if (item.startedAt === undefined) {
        timed = false;
        continue;
      }
      first = Math.min(first, item.startedAt);
      last = Math.max(last, item.startedAt + (item.durationMs ?? 0));
    } else if (item.kind === "reasoning") {
      summed += (item.seconds ?? 0) * 1000;
      if (item.startedAt === undefined || item.endedAt === undefined) {
        timed = false;
        continue;
      }
      first = Math.min(first, item.startedAt);
      last = Math.max(last, item.endedAt);
    }
  }
  return timed && last >= first ? last - first : summed;
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

/** One block of agent steps as a fold: a "Completed in …" rule carrying what kinds
 *  of work the block did, then the compact list of one-line steps (Label · detail)
 *  that each expand to their full card. Rows from the same model request are
 *  grouped, so a step that read four files shows as one request, not four.
 *  Matches the reference harness's shape — one fold per block, not a fold inside
 *  a fold. */
export function RunActivity(props: RunActivityProps) {
  const { items, live } = props;
  const [open, setOpen] = useState(live);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());

  // Follow the run while it streams, then fold the finished block away.
  useEffect(() => {
    setOpen(live);
  }, [live]);

  const rows = useMemo(() => buildRunRows(items), [items]);
  const groups = useMemo(() => groupRowsByStep(rows), [rows]);
  const steps = countSteps(rows);
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
        {steps > 1 && <span className="run__head-steps">{steps} steps</span>}
        <span className="run__head-work">{describeRunWork(items)}</span>
        <Icon name="chevronDown" size={12} className={`run__chev${open ? " run__chev--open" : ""}`} />
      </button>
      {open && (
        <ul className="run__steps">
          {groups.map((group, g) => {
            const grouped = group.step !== undefined && group.rows.length > 1;
            return (
              <li key={g} className={`run-group${grouped ? " run-group--multi" : ""}`}>
                {grouped && (
                  <div className="run-group__tag">
                    Step {group.step} · {group.rows.length} actions
                  </div>
                )}
                <ul className="run-group__rows">
                  {group.rows.map(({ row, index }) => {
                    const isOpen = expanded.has(index);
                    return (
                      <li key={index} className={`run-step run-step--${row.status}`}>
                        <button
                          type="button"
                          className="run-step__row"
                          aria-expanded={isOpen}
                          onClick={() => toggleRow(index)}
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
                        {isOpen && <div className="run-step__body">{props.renderDetail(row.file ?? row.item)}</div>}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
