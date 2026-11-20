import assert from "node:assert/strict";
import test from "node:test";
import {
  blockDurationMs,
  buildRunRows,
  countSteps,
  describeRunWork,
  formatRunDuration,
  groupRowsByStep,
  type ActivityItem,
} from "../src/components/RunActivity.js";

const tool = (name: string): ActivityItem => ({ kind: "tool", name, summary: name, ok: true });
const file = (): ActivityItem => ({ kind: "file", name: "a.ts", subtitle: "", adds: 1, dels: 0 });
const thought = (): ActivityItem => ({ kind: "reasoning", text: "hmm", seconds: 2 });

test("describeRunWork: lists the kinds of work in order", () => {
  assert.equal(
    describeRunWork([tool("bash"), tool("write"), tool("web_fetch")]),
    "Ran commands, wrote files, visited web pages",
  );
});

test("describeRunWork: dedupes and caps at three phrases", () => {
  assert.equal(
    describeRunWork([tool("bash"), tool("bash"), file(), tool("web_fetch"), tool("read")]),
    "Ran commands, wrote files, visited web pages, etc.",
  );
});

test("describeRunWork: reasoning only", () => {
  assert.equal(describeRunWork([thought()]), "Thought it through");
});

test("describeRunWork: unknown tools are generic", () => {
  assert.equal(describeRunWork([tool("my_mcp_tool")]), "Used tools");
});

test("formatRunDuration", () => {
  assert.equal(formatRunDuration(400), "1s");
  assert.equal(formatRunDuration(45_000), "45s");
  assert.equal(formatRunDuration(29 * 60_000 + 27_000), "29m 27s");
  assert.equal(formatRunDuration(3_720_000), "1h 2m");
});

type ToolItem = Extract<ActivityItem, { kind: "tool" }>;
type FileItem = Extract<ActivityItem, { kind: "file" }>;

const call = (name: string, summary: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  name,
  summary,
  ok: true,
  ...extra,
});
const card = (subtitle: string, extra: Partial<FileItem> = {}): FileItem => ({
  kind: "file",
  name: subtitle.split("/").pop() ?? subtitle,
  subtitle,
  adds: 3,
  dels: 1,
  ...extra,
});

test("buildRunRows: a Write call and the file card it made are one row", () => {
  const rows = buildRunRows([call("write", "src/a.ts"), card("/repo/src/a.ts")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, "Write");
  assert.equal(rows[0]!.detail, "src/a.ts  +3 −1");
  assert.equal(rows[0]!.file?.subtitle, "/repo/src/a.ts", "the diff card is what the row expands to");
  assert.equal(rows[0]!.item.kind, "tool");
});

test("buildRunRows: Edit with several edits still pairs, and Windows separators do not matter", () => {
  const rows = buildRunRows([call("edit", ".\\src\\a.ts (3 edits)"), card("C:\\repo\\src\\a.ts")]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.file);
});

test("buildRunRows: notebook edits pair through their cell-qualified summary", () => {
  const rows = buildRunRows([call("notebook_edit", "notebook nb/x.ipynb cell 2"), card("/repo/nb/x.ipynb")]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.file);
});

test("buildRunRows: parallel edits are paired by path, not by position", () => {
  const rows = buildRunRows([
    call("write", "a.ts"),
    call("write", "b.ts"),
    card("/r/b.ts", { adds: 9, dels: 0 }),
    card("/r/a.ts", { adds: 2, dels: 0 }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.detail, "a.ts  +2 −0");
  assert.equal(rows[1]!.detail, "b.ts  +9 −0");
});

test("buildRunRows: two edits to one file pair in order", () => {
  const rows = buildRunRows([
    call("edit", "a.ts"),
    card("/r/a.ts", { adds: 1, dels: 0 }),
    call("edit", "a.ts"),
    card("/r/a.ts", { adds: 5, dels: 2 }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.detail),
    ["a.ts  +1 −0", "a.ts  +5 −2"],
  );
});

test("buildRunRows: a failed edit made no card, so a later card is not pinned on it", () => {
  const rows = buildRunRows([call("edit", "a.ts", { ok: false }), call("edit", "a.ts"), card("/r/a.ts")]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.file, undefined);
  assert.equal(rows[0]!.status, "failed");
  assert.ok(rows[1]!.file);
});

test("buildRunRows: a card with no call to pair with keeps its own row", () => {
  const rows = buildRunRows([call("patch", "apply patch"), card("/r/a.ts"), card("/r/b.ts")]);
  assert.deepEqual(
    rows.map((r) => r.label),
    ["Patch", "Edit", "Edit"],
  );
});

test("buildRunRows: a running edit already takes its card", () => {
  const rows = buildRunRows([call("write", "a.ts", { ok: undefined }), card("/r/a.ts")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "running");
  assert.ok(rows[0]!.file);
});

test("buildRunRows: calls from another step are not paired", () => {
  const rows = buildRunRows([call("write", "a.ts", { step: 1 }), card("/r/a.ts", { step: 2 })]);
  assert.equal(rows.length, 2);
});

test("buildRunRows: other tools and reasoning pass through untouched", () => {
  const rows = buildRunRows([thought(), call("bash", "ls"), call("read", "a.ts")]);
  assert.deepEqual(
    rows.map((r) => r.label),
    ["Think", "Bash", "Read"],
  );
});

test("groupRowsByStep: rows of one step group together, in order", () => {
  const rows = buildRunRows([
    { kind: "reasoning", text: "plan", seconds: 1, step: 1 },
    call("read", "a.ts", { step: 1 }),
    call("read", "b.ts", { step: 1 }),
    call("bash", "ls", { step: 2 }),
  ]);
  const groups = groupRowsByStep(rows);
  assert.deepEqual(
    groups.map((g) => [g.step, g.rows.map((r) => r.index)]),
    [
      [1, [0, 1, 2]],
      [2, [3]],
    ],
  );
  assert.equal(countSteps(rows), 2);
});

test("groupRowsByStep: rows with no step stay separate rather than collapsing into one group", () => {
  const rows = buildRunRows([call("read", "a.ts"), call("read", "b.ts")]);
  assert.equal(groupRowsByStep(rows).length, 2);
  assert.equal(countSteps(rows), 0);
});

test("groupRowsByStep: a step that comes back later is a new group, not a merge across other steps", () => {
  const rows = buildRunRows([
    call("read", "a.ts", { step: 1 }),
    call("read", "b.ts", { step: 2 }),
    call("read", "c.ts", { step: 1 }),
  ]);
  assert.equal(groupRowsByStep(rows).length, 3);
  assert.equal(countSteps(rows), 2);
});

test("blockDurationMs: parallel tools count once, and time between steps is included", () => {
  const items: ActivityItem[] = [
    { kind: "reasoning", text: "plan", seconds: 2, startedAt: 1_000, endedAt: 3_000 },
    // Three reads started together and ran for 4s: 4s of wall clock, not 12s.
    call("read", "a", { startedAt: 3_500, durationMs: 4_000 }),
    call("read", "b", { startedAt: 3_500, durationMs: 4_000 }),
    call("read", "c", { startedAt: 3_500, durationMs: 4_000 }),
    // The model thought for a while after the reads before the next call.
    call("bash", "ls", { startedAt: 10_000, durationMs: 500 }),
  ];
  assert.equal(blockDurationMs(items), 9_500);
});

test("blockDurationMs: blocks recorded before timestamps existed fall back to summed durations", () => {
  const items: ActivityItem[] = [
    { kind: "reasoning", text: "plan", seconds: 2 },
    call("read", "a", { durationMs: 1_500 }),
    call("bash", "ls", { durationMs: 500 }),
  ];
  assert.equal(blockDurationMs(items), 4_000);
});

test("blockDurationMs: one untimed item sends the whole block to the fallback, not a partial span", () => {
  const items: ActivityItem[] = [
    { kind: "reasoning", text: "old", seconds: 5 },
    call("read", "a", { startedAt: 10_000, durationMs: 1_000 }),
  ];
  assert.equal(blockDurationMs(items), 6_000);
});

test("blockDurationMs: a tool that never ended still bounds the span by its start", () => {
  const items: ActivityItem[] = [call("bash", "sleep", { startedAt: 1_000, ok: undefined }), call("read", "a", { startedAt: 2_000, durationMs: 500 })];
  assert.equal(blockDurationMs(items), 1_500);
});
