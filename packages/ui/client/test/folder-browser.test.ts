import assert from "node:assert/strict";
import test from "node:test";
import {
  breadcrumbSegments,
  filterDirectoryEntries,
  parentPath,
  wslBrowseRoot,
} from "../src/components/project-picker/folder-browser-utils.js";
import type { DirectoryEntry } from "@deyin/contract";

test("breadcrumbSegments builds path crumbs", () => {
  const crumbs = breadcrumbSegments("/home/me/github");
  assert.deepEqual(crumbs.map((c) => c.label), ["home", "me", "github"]);
});

test("filterDirectoryEntries keeps directories only by default", () => {
  const entries: DirectoryEntry[] = [
    { name: "src", path: "/p/src", kind: "directory" },
    { name: "readme.md", path: "/p/readme.md", kind: "file" },
  ];
  assert.equal(filterDirectoryEntries(entries, "").length, 1);
});

test("parentPath walks up", () => {
  assert.equal(parentPath("/home/me"), "/home");
  assert.equal(parentPath("/"), null);
});

test("wslBrowseRoot uses UNC", () => {
  assert.match(wslBrowseRoot("Ubuntu-22.04"), /wsl\.localhost/);
});
