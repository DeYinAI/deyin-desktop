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
  assert.deepEqual(crumbs.map((c) => c.path), ["/home", "/home/me", "/home/me/github"]);
});

test("breadcrumbSegments handles WSL UNC paths properly", () => {
  const crumbs = breadcrumbSegments("\\\\wsl.localhost\\Ubuntu-22.04\\home\\anh");
  assert.deepEqual(crumbs.map((c) => c.label), ["Ubuntu-22.04", "home", "anh"]);
  assert.deepEqual(crumbs.map((c) => c.path), [
    "//wsl.localhost/Ubuntu-22.04",
    "//wsl.localhost/Ubuntu-22.04/home",
    "//wsl.localhost/Ubuntu-22.04/home/anh",
  ]);
});

test("breadcrumbSegments handles Windows drive paths properly", () => {
  const crumbs = breadcrumbSegments("C:\\Users\\anh\\project");
  assert.deepEqual(crumbs.map((c) => c.label), ["C:", "Users", "anh", "project"]);
  assert.deepEqual(crumbs.map((c) => c.path), [
    "C:/",
    "C:/Users",
    "C:/Users/anh",
    "C:/Users/anh/project",
  ]);
});

test("filterDirectoryEntries keeps directories only by default", () => {
  const entries: DirectoryEntry[] = [
    { name: "src", path: "/p/src", kind: "directory" },
    { name: "readme.md", path: "/p/readme.md", kind: "file" },
  ];
  assert.equal(filterDirectoryEntries(entries, "").length, 1);
  assert.equal(filterDirectoryEntries(entries, "sr").length, 1);
  assert.equal(filterDirectoryEntries(entries, "notfound").length, 0);
});

test("parentPath walks up posix paths", () => {
  assert.equal(parentPath("/home/me/project"), "/home/me");
  assert.equal(parentPath("/home/me"), "/home");
  assert.equal(parentPath("/home"), "/");
  assert.equal(parentPath("/"), null);
});

test("parentPath walks up WSL UNC paths without breaking share root", () => {
  assert.equal(parentPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\anh"), "//wsl.localhost/Ubuntu-22.04/home");
  assert.equal(parentPath("//wsl.localhost/Ubuntu-22.04/home"), "//wsl.localhost/Ubuntu-22.04");
  assert.equal(parentPath("//wsl.localhost/Ubuntu-22.04"), null);
});

test("parentPath walks up Windows drive paths", () => {
  assert.equal(parentPath("C:\\Users\\anh"), "C:/Users");
  assert.equal(parentPath("C:/Users"), "C:/");
  assert.equal(parentPath("C:/"), null);
  assert.equal(parentPath("C:"), null);
});

test("wslBrowseRoot uses UNC", () => {
  assert.match(wslBrowseRoot("Ubuntu-22.04"), /wsl\.localhost/);
});
