import assert from "node:assert/strict";
import { test } from "node:test";
import { toWslPath, windowsSpawnCwd, wslUncDistro } from "../src/host/wsl-path.js";

test("toWslPath converts WSL UNC paths to distro-local paths", () => {
  assert.equal(toWslPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\anh\\proj"), "/home/user/proj");
  assert.equal(toWslPath("\\\\wsl$\\Ubuntu-22.04\\home\\anh\\proj"), "/home/user/proj");
  // Case-insensitive host, trailing separator.
  assert.equal(toWslPath("\\\\WSL.LOCALHOST\\Debian\\srv\\app\\"), "/srv/app");
  // Distro root.
  assert.equal(toWslPath("\\\\wsl.localhost\\Ubuntu-22.04"), "/");
});

test("toWslPath maps Windows drives onto /mnt", () => {
  assert.equal(toWslPath("C:\\Users\\User\\proj"), "/mnt/c/Users/User/proj");
  assert.equal(toWslPath("D:/data"), "/mnt/d/data");
  assert.equal(toWslPath("C:\\"), "/mnt/c");
});

test("toWslPath leaves POSIX paths untouched", () => {
  assert.equal(toWslPath("/home/user/proj"), "/home/user/proj");
  assert.equal(toWslPath("/"), "/");
});

test("wslUncDistro identifies the distro only for UNC paths", () => {
  assert.equal(wslUncDistro("\\\\wsl.localhost\\Ubuntu-22.04\\home"), "Ubuntu-22.04");
  assert.equal(wslUncDistro("C:\\Users\\User"), null);
  assert.equal(wslUncDistro("/home/user"), null);
});

test("windowsSpawnCwd rejects directories CreateProcess cannot use", () => {
  const fallback = process.env.USERPROFILE ?? process.env.SystemRoot ?? "C:\\";
  assert.equal(windowsSpawnCwd("\\\\wsl.localhost\\Ubuntu-22.04\\home\\anh"), fallback);
  assert.equal(windowsSpawnCwd("/home/user"), fallback);
  // A real Windows directory is usable as-is.
  assert.equal(windowsSpawnCwd("C:\\Users\\User\\proj"), "C:\\Users\\User\\proj");
});
