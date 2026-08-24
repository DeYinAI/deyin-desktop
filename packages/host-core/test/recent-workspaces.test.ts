import assert from "node:assert/strict";
import test from "node:test";
import {
  displayLocationPath,
  filterRecentProjects,
  locationKey,
  recentProjects,
  touchProjectOpened,
} from "../src/recent-workspaces.js";
import type { Project } from "../src/types.js";

function proj(id: string, root: string, lastOpenedAt?: string): Project {
  return { id, name: root.split("/").pop() ?? root, root, threads: [], lastOpenedAt };
}

test("locationKey dedupes local paths", () => {
  assert.equal(locationKey({ kind: "local", root: "/home/me/foo" }), locationKey({ kind: "local", root: "/home/me/foo/" }));
});

test("recentProjects sorts by lastOpenedAt", () => {
  const projects = [proj("a", "/a", "2020-01-01"), proj("b", "/b", "2024-01-01")];
  assert.equal(recentProjects(projects)[0]?.id, "b");
});

test("filterRecentProjects matches name and path", () => {
  const projects = [proj("a", "/home/me/deyin-desktop", "2024-01-01")];
  assert.equal(filterRecentProjects(projects, "deyin", "/home/me").length, 1);
  assert.equal(filterRecentProjects(projects, "missing").length, 0);
});

test("displayLocationPath shortens home", () => {
  assert.equal(displayLocationPath({ kind: "local", root: "/home/me/foo" }, "/home/me"), "~/foo");
});

test("touchProjectOpened updates timestamp", () => {
  const projects = [proj("a", "/a")];
  const next = touchProjectOpened(projects, "a");
  assert.ok(next[0]?.lastOpenedAt);
});
