import assert from "node:assert/strict";
import test from "node:test";
import type { Thread } from "@deyin/host-core/shared";
import { applyGoalToProjects, isReplacingGoal } from "../src/threadGoal.js";

function thread(id: string): Thread {
  return { id, title: "New task", updatedAt: 0, events: [] };
}

test("applyGoalToProjects creates project + thread on empty new chat", () => {
  const t = thread("thread-1");
  const { projects, createdProjectId } = applyGoalToProjects([], t, "All tests pass", null);
  assert.ok(createdProjectId);
  assert.equal(projects.length, 1);
  assert.equal(projects[0]!.threads.length, 1);
  const saved = projects[0]!.threads[0]!;
  assert.equal(saved.id, "thread-1");
  assert.equal(saved.goal?.text, "All tests pass");
  assert.equal(saved.goal?.status, "active");
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0]?.kind, "goal-set");
});

test("applyGoalToProjects upserts goal on an existing empty thread", () => {
  const t = thread("thread-2");
  const initial = [{ id: "proj-a", name: "Workspace", root: null, threads: [t] }];
  const { projects, createdProjectId } = applyGoalToProjects(initial, t, "Ship v1", "proj-a");
  assert.equal(createdProjectId, undefined);
  assert.equal(projects[0]!.threads[0]!.goal?.text, "Ship v1");
  assert.equal(projects[0]!.threads[0]!.events[0]?.kind, "goal-set");
});

test("applyGoalToProjects clears goal and records timeline note", () => {
  const t: Thread = {
    ...thread("thread-3"),
    goal: { text: "Old", status: "active" },
    events: [{ kind: "goal-set", text: "Old" }],
  };
  const initial = [{ id: "proj-a", name: "Workspace", root: null, threads: [t] }];
  const { projects } = applyGoalToProjects(initial, t, null, "proj-a");
  const saved = projects[0]!.threads[0]!;
  assert.equal(saved.goal, undefined);
  assert.equal(saved.events.at(-1)?.kind, "goal-set");
  assert.equal(saved.events.at(-1)?.text, null);
});

test("isReplacingGoal: only an unfinished goal is replaced", () => {
  assert.equal(isReplacingGoal(undefined), false);
  assert.equal(isReplacingGoal({ text: "x", status: "active" }), true);
  assert.equal(isReplacingGoal({ text: "x", status: "paused" }), true);
  assert.equal(isReplacingGoal({ text: "x", status: "blocked" }), true);
  assert.equal(isReplacingGoal({ text: "x", status: "exhausted" }), true);
  assert.equal(isReplacingGoal({ text: "x", status: "met" }), false);
  assert.equal(isReplacingGoal({ text: "x", status: "done" }), false);
});

test("applyGoalToProjects marks the note 'replaced' when an unfinished goal is overwritten", () => {
  const t: Thread = {
    ...thread("thread-4"),
    goal: { id: "g-old", text: "Old", status: "active", rounds: 3, maxRounds: 25 },
    events: [{ kind: "goal-set", text: "Old" }],
  };
  const initial = [{ id: "proj-a", name: "Workspace", root: null, threads: [t] }];
  const { projects } = applyGoalToProjects(initial, t, "New", "proj-a");
  const saved = projects[0]!.threads[0]!;
  assert.equal(saved.goal?.text, "New");
  assert.equal(saved.goal?.status, "active");
  assert.equal(saved.goal?.rounds, 0, "a replacement starts from round zero");
  assert.notEqual(saved.goal?.id, "g-old", "a replacement gets a fresh id so a stale continuation cannot apply");
  assert.deepEqual(saved.events.at(-1), { kind: "goal-set", text: "New", replaced: true });
});

test("applyGoalToProjects does not mark 'replaced' after a met goal or on a first goal", () => {
  const met: Thread = { ...thread("thread-5"), goal: { text: "Old", status: "met" } };
  const initial = [{ id: "proj-a", name: "Workspace", root: null, threads: [met] }];
  const afterMet = applyGoalToProjects(initial, met, "New", "proj-a").projects[0]!.threads[0]!;
  assert.deepEqual(afterMet.events.at(-1), { kind: "goal-set", text: "New" });

  const fresh = thread("thread-6");
  const first = applyGoalToProjects([{ id: "proj-a", name: "Workspace", root: null, threads: [fresh] }], fresh, "New", "proj-a")
    .projects[0]!.threads[0]!;
  assert.deepEqual(first.events.at(-1), { kind: "goal-set", text: "New" });
});

test("applyGoalToProjects stores a caller-armed goal as-is (same id the run is started with)", () => {
  const t = thread("thread-7");
  const armed = { id: "g-armed", text: "Ship it", status: "active" as const, rounds: 0, maxRounds: 25, boot: "b1" };
  const { projects } = applyGoalToProjects([{ id: "proj-a", name: "Workspace", root: null, threads: [t] }], t, "Ship it", "proj-a", "Workspace", {
    armed,
  });
  assert.deepEqual(projects[0]!.threads[0]!.goal, armed);
});

test("applyGoalToProjects with recordEvent=false leaves the timeline to the caller", () => {
  const t = thread("thread-8");
  const { projects } = applyGoalToProjects([{ id: "proj-a", name: "Workspace", root: null, threads: [t] }], t, "Ship it", "proj-a", "Workspace", {
    recordEvent: false,
  });
  const saved = projects[0]!.threads[0]!;
  assert.equal(saved.goal?.text, "Ship it");
  assert.equal(saved.events.length, 0);
});
