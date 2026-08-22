#!/usr/bin/env node
// Build script: compiles the Rust cdylib and copies the platform binary into
// this package as deyin-native.node. No @napi-rs/cli dependency needed —
// cargo + fs copy is the entire toolchain.
const { execSync } = require("node:child_process");
const { copyFileSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const crateDir = join(__dirname, "..", "..", "..", "native", "deyin-native");
const pkgDir = join(__dirname, "..");
const debug = process.argv.includes("--debug");

const args = debug ? [] : ["--release"];
// spawnSync with an explicit shell can fail in sandboxed environments; use
// spawnSync on the cargo binary directly (no shell involved).
const { spawnSync } = require("node:child_process");
const cargo = process.env.CARGO || "cargo";
// rustup shims resolve through PATH; pass the parent PATH explicitly since
// sandboxed spawns may not inherit it.
const res = spawnSync(cargo, ["build", ...args], {
  cwd: crateDir,
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: `${join(require("node:os").homedir(), ".cargo", "bin")}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
  },
});
if (res.error || res.status !== 0) {
  console.error(`cargo build failed: status=${res.status} error=${res.error}`);
  process.exit(1);
}

const targetDir = join(crateDir, "target", debug ? "debug" : "release");
const names = {
  linux: "libdeyin_native.so",
  darwin: "libdeyin_native.dylib",
  win32: "deyin_native.dll",
};
const src = join(targetDir, names[process.platform] ?? names.linux);
if (!existsSync(src)) {
  console.error(`Built binary not found at ${src}`);
  process.exit(1);
}
mkdirSync(pkgDir, { recursive: true });
copyFileSync(src, join(pkgDir, "deyin-native.node"));
console.log(`Copied ${src} -> packages/native-core/deyin-native.node`);
