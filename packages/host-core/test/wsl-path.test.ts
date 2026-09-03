import assert from "node:assert/strict";
import { test } from "node:test";
import { preferWslShellForCwd, toWslPath, mapPosixOntoWslUnc, windowsSpawnCwd, wslLaunchArgs, wslTerminalSpawn, wslUncDistro } from "../src/host/wsl-path.js";

test("toWslPath converts WSL UNC paths to distro-local paths", () => {
 assert.equal(toWslPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\proj"), "/home/user/proj");
 assert.equal(toWslPath("\\\\wsl$\\Ubuntu-22.04\\home\\user\\proj"), "/home/user/proj");
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

test("mapPosixOntoWslUnc maps distro-local paths onto UNC roots", () => {
  const unc = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\anh\\project";
  assert.equal(mapPosixOntoWslUnc(unc, "/home/anh/project"), unc);
  assert.equal(
    mapPosixOntoWslUnc(unc, "/home/anh/project/oracle_cloud_account.txt"),
    `${unc}\\oracle_cloud_account.txt`,
  );
  assert.equal(mapPosixOntoWslUnc(unc, "/etc/passwd"), null);
});

test("wslUncDistro identifies the distro only for UNC paths", () => {
 assert.equal(wslUncDistro("\\\\wsl.localhost\\Ubuntu-22.04\\home"), "Ubuntu-22.04");
 assert.equal(wslUncDistro("C:\\Users\\User"), null);
 assert.equal(wslUncDistro("/home/user"), null);
});

test("windowsSpawnCwd rejects directories CreateProcess cannot use", () => {
 const fallback = process.env.USERPROFILE ?? process.env.SystemRoot ?? "C:\\";
 assert.equal(windowsSpawnCwd("\\\\wsl.localhost\\Ubuntu-22.04\\home\\user"), fallback);
 assert.equal(windowsSpawnCwd("/home/user"), fallback);
 // A real Windows directory is usable as-is.
 assert.equal(windowsSpawnCwd("C:\\Users\\User\\proj"), "C:\\Users\\User\\proj");
});

test("wslTerminalSpawn maps UNC cwd to a Windows launch dir plus in-distro cd", () => {
 const unc = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\proj";
 const { spawnCwd, initialCd } = wslTerminalSpawn(unc);
 assert.notEqual(spawnCwd, unc);
 assert.equal(initialCd, "/home/user/proj");
});

test("wslTerminalSpawn maps Windows drive cwd to /mnt for post-spawn cd", () => {
 const { spawnCwd, initialCd } = wslTerminalSpawn("C:\\Users\\User\\proj");
 assert.equal(spawnCwd, "C:\\Users\\User\\proj");
 assert.equal(initialCd, "/mnt/c/Users/User/proj");
});

test("wslLaunchArgs starts the shell inside the project directory", () => {
 assert.deepEqual(wslLaunchArgs("Ubuntu-22.04", "/home/user/proj"), [
  "-d",
  "Ubuntu-22.04",
  "--cd",
  "/home/user/proj",
 ]);
 // Root/empty keeps the distro default home instead of System32.
 assert.deepEqual(wslLaunchArgs("Ubuntu-22.04", "/"), ["-d", "Ubuntu-22.04", "--cd", "~"]);
 assert.deepEqual(wslLaunchArgs("Ubuntu-22.04", null), ["-d", "Ubuntu-22.04", "--cd", "~"]);
});

test("preferWslShellForCwd picks the distro shell for a UNC workspace", () => {
 const shells = [
  { id: "wsl:Ubuntu-22.04", kind: "wsl" },
  { id: "pwsh", kind: "windows" },
 ];
 assert.equal(
  preferWslShellForCwd(shells, "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\proj"),
  "wsl:Ubuntu-22.04",
 );
 // Legacy wsl$ form matches too.
 assert.equal(preferWslShellForCwd(shells, "\\\\wsl$\\Ubuntu-22.04\\srv\\app"), "wsl:Ubuntu-22.04");
 // Non-UNC cwd and missing-distro cases stay null.
 assert.equal(preferWslShellForCwd(shells, "C:\\Users\\User\\proj"), null);
 assert.equal(preferWslShellForCwd(shells, "/home/user/proj"), null);
 assert.equal(preferWslShellForCwd([], "\\\\wsl.localhost\\Ubuntu-22.04\\home"), null);
 assert.equal(preferWslShellForCwd([{ id: "pwsh", kind: "windows" }], "\\\\wsl.localhost\\Debian\\srv"), null);
});
