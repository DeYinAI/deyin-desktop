import assert from "node:assert/strict";
import test from "node:test";
import type { Thread } from "@deyin/host-core/shared";
import { applyGoalToProjects } from "../src/threadGoal.js";

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
