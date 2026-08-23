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

const { spawnSync } = require("node:child_process");
const cargo = process.env.CARGO || "cargo";
const pathEnv = `${join(require("node:os").homedir(), ".cargo", "bin")}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
const cargoEnv = {
  ...process.env,
  PATH: pathEnv,
  RUSTFLAGS: [
    process.env.RUSTFLAGS,
    `--remap-path-prefix=${require("node:os").homedir()}=/build`,
  ]
    .filter(Boolean)
    .join(" "),
};

const cargoProbe = spawnSync(cargo, ["--version"], { encoding: "utf8", env: cargoEnv });
if (cargoProbe.error?.code === "ENOENT") {
  console.log("cargo not found; skipping native-core build (TS fallbacks will be used)");
  process.exit(0);
}

const args = debug ? [] : ["--release"];
const res = spawnSync(cargo, ["build", ...args], {
  cwd: crateDir,
  stdio: "inherit",
  env: cargoEnv,
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
const out = join(pkgDir, "deyin-native.node");
try {
  execSync(`strip "${out}"`, { stdio: "ignore" });
} catch {
  // strip is optional (e.g. some Windows toolchains)
}
console.log(`Copied ${src} -> ${out}`);
