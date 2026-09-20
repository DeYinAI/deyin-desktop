import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectProjectToolchain, formatProjectToolchainPrompt } from "../src/project-detect.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-detect-test-"));
}

test("detects Node/TypeScript project with pnpm and custom scripts", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest run",
          build: "tsup",
          typecheck: "tsc --noEmit",
          lint: "eslint .",
        },
      }),
    );
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0");

    const info = await detectProjectToolchain(dir);
    assert.ok(info);
    assert.equal(info.primaryLanguage, "typescript");
    assert.equal(info.packageManager, "pnpm");
    assert.equal(info.commands.test, "pnpm test");
    assert.equal(info.commands.build, "pnpm build");
    assert.equal(info.commands.typecheck, "pnpm typecheck");
    assert.equal(info.commands.lint, "pnpm lint");

    const prompt = formatProjectToolchainPrompt(info);
    assert.ok(prompt?.includes("Language: typescript"));
    assert.ok(prompt?.includes("pnpm"));
    assert.ok(prompt?.includes("pnpm test"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detects Rust project with cargo", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n");
    writeFileSync(join(dir, "Cargo.lock"), "# lockfile");

    const info = await detectProjectToolchain(dir);
    assert.ok(info);
    assert.equal(info.primaryLanguage, "rust");
    assert.equal(info.packageManager, "cargo");
    assert.equal(info.commands.test, "cargo test");
    assert.equal(info.commands.build, "cargo build");
    assert.equal(info.commands.typecheck, "cargo check");
    assert.equal(info.commands.lint, "cargo clippy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detects Go project with go.mod", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "go.mod"), "module example.com/demo\n\ngo 1.22\n");

    const info = await detectProjectToolchain(dir);
    assert.ok(info);
    assert.equal(info.primaryLanguage, "go");
    assert.equal(info.packageManager, "go");
    assert.equal(info.commands.test, "go test ./...");
    assert.equal(info.commands.build, "go build ./...");
    assert.equal(info.commands.typecheck, "go vet ./...");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detects Python project with uv.lock", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = \"demo\"\n");
    writeFileSync(join(dir, "uv.lock"), "# uv lockfile");

    const info = await detectProjectToolchain(dir);
    assert.ok(info);
    assert.equal(info.primaryLanguage, "python");
    assert.equal(info.packageManager, "uv");
    assert.equal(info.commands.test, "uv run pytest");
    assert.equal(info.commands.typecheck, "uv run mypy .");
    assert.equal(info.commands.lint, "uv run ruff check");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detects Python project with .venv directory and augments prompt", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "requirements.txt"), "flask\n");
    const venvDir = join(dir, ".venv");
    mkdirSync(join(venvDir, "bin"), { recursive: true });
    writeFileSync(join(venvDir, "bin", "python"), "#!/bin/sh\n");

    const info = await detectProjectToolchain(dir);
    assert.ok(info);
    assert.equal(info.primaryLanguage, "python");
    assert.equal(info.virtualEnv, ".venv");

    const prompt = formatProjectToolchainPrompt(info);
    assert.ok(prompt?.includes(".venv"));
    assert.ok(prompt?.includes("automatically active in PATH"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detects Java project with Maven", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "pom.xml"), "<project></project>");

    const info = await detectProjectToolchain(dir);
    assert.ok(info);
    assert.equal(info.primaryLanguage, "java");
    assert.equal(info.packageManager, "maven");
    assert.equal(info.commands.test, "mvn test");
    assert.equal(info.commands.build, "mvn compile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detects monorepo when pnpm-workspace.yaml is present", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");

    const info = await detectProjectToolchain(dir);
    assert.ok(info);
    assert.equal(info.isMonorepo, true);

    const prompt = formatProjectToolchainPrompt(info);
    assert.ok(prompt?.includes("(monorepo)"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
