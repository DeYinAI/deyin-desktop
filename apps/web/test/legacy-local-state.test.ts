import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConductorWorkflowDefinition, ProjectsState, Thread } from "@deyin/host-core/shared";
import {
  CONDUCTOR_WORKFLOWS_KEY,
  EMPTY_PROJECTS,
  LEGACY_CONDUCTOR_WORKFLOWS_KEY,
  PROJECTS_KEY,
  readConductorWorkflows,
  readProjects,
  type KeyValueStore,
} from "../src/client/legacy-local-state.js";

function fakeStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string>; writes: string[] } {
  const data = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    data,
    writes,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(key);
      data.set(key, value);
    },
  };
}

function legacyProjects(): string {
  const thread = { id: "t1", title: "Release", updatedAt: 1, mode: "bot", events: [{ kind: "tool", name: "bot_workflow_run", summary: "run" }] } as unknown as Thread;
  const state: ProjectsState = {
    projects: [{ id: "p", name: "app", root: "/app", threads: [thread] }],
    activeProjectId: "p",
    activeThreadId: "t1",
    workspaceRoot: "/app",
  };
  return JSON.stringify(state);
}

test("readProjects upgrades a legacy bot thread and caches the upgraded state", () => {
  const store = fakeStore({ [PROJECTS_KEY]: legacyProjects() });
  const state = readProjects(store);
  const thread = state.projects[0]!.threads[0]!;
  assert.equal(thread.mode, "conductor");
  assert.equal(thread.events[0]!.kind === "tool" ? thread.events[0].name : "", "conductor_workflow_run");
  assert.deepEqual(store.writes, [PROJECTS_KEY], "written back once");

  const again = readProjects(store);
  assert.equal(again.projects[0]!.threads[0]!.mode, "conductor");
  assert.equal(store.writes.length, 1, "an already-current state is not rewritten");
});

test("readProjects returns an empty state for missing or corrupt storage", () => {
  assert.deepEqual(readProjects(fakeStore()), EMPTY_PROJECTS);
  assert.deepEqual(readProjects(fakeStore({ [PROJECTS_KEY]: "{not json" })), EMPTY_PROJECTS);
  assert.deepEqual(readProjects(fakeStore({ [PROJECTS_KEY]: "[]" })), EMPTY_PROJECTS);
});

test("readProjects fills fields an older blob lacks", () => {
  const store = fakeStore({ [PROJECTS_KEY]: JSON.stringify({ projects: [], activeProjectId: "x" }) });
  const state = readProjects(store);
  assert.equal(state.activeProjectId, "x");
  assert.equal(state.workspaceRoot, null);
});

function workflow(id: string): ConductorWorkflowDefinition {
  return { id, name: id, stages: [], createdAt: 1, updatedAt: 1 } as unknown as ConductorWorkflowDefinition;
}

test("readConductorWorkflows falls back to the legacy key until the new one exists", () => {
  const store = fakeStore({ [LEGACY_CONDUCTOR_WORKFLOWS_KEY]: JSON.stringify([workflow("old")]) });
  assert.deepEqual(readConductorWorkflows(store).map((w) => w.id), ["old"]);
});

test("readConductorWorkflows prefers the new key, even when it is an empty list", () => {
  const store = fakeStore({
    [LEGACY_CONDUCTOR_WORKFLOWS_KEY]: JSON.stringify([workflow("old")]),
    [CONDUCTOR_WORKFLOWS_KEY]: JSON.stringify([]),
  });
  assert.deepEqual(readConductorWorkflows(store), [], "deleting the last pipeline must not resurrect the legacy copy");
});

test("readConductorWorkflows tolerates storage failures and bad data", () => {
  assert.deepEqual(readConductorWorkflows(fakeStore()), []);
  assert.deepEqual(readConductorWorkflows(fakeStore({ [CONDUCTOR_WORKFLOWS_KEY]: "{oops" })), []);
  assert.deepEqual(readConductorWorkflows(fakeStore({ [CONDUCTOR_WORKFLOWS_KEY]: '{"not":"a list"}' })), []);
  const throwing: KeyValueStore = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => undefined,
  };
  assert.deepEqual(readConductorWorkflows(throwing), []);
});
