import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diffTextTool, envInfoTool, fileTreeTool, lcsDiff, processListTool, redactArgs } from "../src/tools/index.js";
import type { ToolContext } from "../src/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-tools-"));
}

const ctx = (cwd: string): ToolContext => ({ cwd, todos: [] });

test("file_tree renders shape, skips ignored dirs, respects depth cap", async () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, "src", "components"), { recursive: true });
    mkdirSync(join(dir, "src", "utils"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "x");
    writeFileSync(join(dir, "src", "components", "App.tsx"), "x");
    writeFileSync(join(dir, "src", "utils", "a.ts"), "x");
    writeFileSync(join(dir, "README.md"), "x");

    const deep = await fileTreeTool.execute({}, ctx(dir));
    assert.ok(deep.includes("src/"));
    assert.ok(deep.includes("README.md"));
    assert.ok(!deep.includes("node_modules"), "node_modules must be skipped");
    assert.ok(deep.includes("components/"));

    const shallow = await fileTreeTool.execute({ path: "src", max_depth: 1 }, ctx(dir));
    assert.ok(shallow.includes("components/ …"), "depth cap collapses deeper dirs");
    assert.ok(!shallow.includes("App.tsx"), "depth cap hides nested files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env_info reports platform and PATH without leaking secrets", async () => {
  const before = process.env.DEYIN_TEST_API_TOKEN;
  process.env.DEYIN_TEST_API_TOKEN = "sk-super-secret-12345";
  try {
    const out = await envInfoTool.execute({}, ctx(process.cwd()));
    assert.ok(out.includes("platform:"));
    assert.ok(out.includes("PATH="), "PATH must be listed");
    assert.ok(out.includes("tools:"), "tool availability must be listed");
    assert.ok(!out.includes("sk-super-secret-12345"), "secret-shaped values must never appear");
    assert.ok(!out.includes("DEYIN_TEST_API_TOKEN="), "secret-named vars must not be listed");
  } finally {
    if (before === undefined) delete process.env.DEYIN_TEST_API_TOKEN;
    else process.env.DEYIN_TEST_API_TOKEN = before;
  }
});

test("diff_text produces unified-style +/- lines and (no differences)", async () => {
  const out = await diffTextTool.execute(
    { left: "a\nb\nc", right: "a\nB\nc\nd" },
    ctx(process.cwd()),
  );
  assert.ok(out.includes("  a"));
  assert.ok(out.includes("- b"));
  assert.ok(out.includes("+ B"));
  assert.ok(out.includes("+ d"));
  const same = await diffTextTool.execute({ left: "x\ny", right: "x\ny" }, ctx(process.cwd()));
  assert.ok(same.includes("(no differences)"));
  // LCS is order-correct: reordering lines produces del/add pairs, not garbage.
  const reorder = lcsDiff("one\ntwo\nthree", "two\none\nthree");
  assert.deepEqual(
    reorder.map((l) => l.type),
    ["del", "context", "add", "context"],
  );
});

test("process_list returns rows and honors the name filter", { skip: process.platform === "win32" }, async () => {
  const out = await processListTool.execute({}, ctx(process.cwd()));
  assert.ok(/^\d+\t/.test(out), "rows are pid<TAB>name");
  const filtered = await processListTool.execute({ name: "node" }, ctx(process.cwd()));
  assert.ok(!filtered.startsWith("ERROR"), filtered);
  assert.ok(filtered.length > 0, "the test runner itself is a node process");
});

test("process_list redacts credential-shaped argv", () => {
  const cases: Array<[string, string[]]> = [
    ["serve --api-key sk-1234567890abcdef --port 8080", ["sk-1234567890abcdef"]],
    ["curl -H \"Authorization: Bearer abc123\" http://x", ["abc123"]],
    ["run?token=secret-value&x=1", ["secret-value"]],
    ["--password hunter2 start", ["hunter2"]],
    ["--aws-secret-access-key=xyz789 start", ["xyz789"]],
    ["run?access_key=AKIAIOSFODNN7EXAMPLE&x=1", ["AKIAIOSFODNN7EXAMPLE"]],
    ["TOKEN=abc123 npm start", ["abc123"]],
    ['tool --api_token "quoted value" run', ["quoted", "value"]],
    ['tool --api_token "my secret password" run', ["my", "secret", "password"]],
    ["AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE npm start", ["AKIAIOSFODNN7EXAMPLE"]],
    ["docker run -e API_KEY=abc --name x img", ["abc"]],
    ["node app.js ghp_abcdefghijklmnopqrstuvwxyz123456", ["ghp_abcdefghijklmnopqrstuvwxyz123456"]],
    ["run --config=sk-1234567890abcdef --port 8080", ["sk-1234567890abcdef"]],
    ["git clone https://user:hunter2@example.com/repo.git", ["hunter2"]],
    ["DATABASE_URL=postgres://user:hunter2@db.example.com/app npm start", ["hunter2"]],
    ["run --db-url=postgres://user:hunter2@db.example.com/app", ["hunter2"]],
    ["pgcli postgres://app:p@ssw0rd@db.example.com/app", ["p@ssw0rd"]],
  ];
  for (const [argv, secrets] of cases) {
    const redacted = redactArgs(argv);
    for (const secret of secrets) {
      assert.ok(!redacted.includes(secret), `"${secret}" leaked from: ${argv} -> ${redacted}`);
    }
    assert.ok(redacted.includes("(redacted)"), `nothing redacted for: ${argv} -> ${redacted}`);
  }
  // Ordinary flags and values pass through untouched.
  const clean = redactArgs("npm run dev --port 3000");
  assert.ok(clean.includes("npm run dev") && clean.includes("3000"));
  assert.ok(!clean.includes("(redacted)"));
  // Unquoted secret values swallow only their own value token, not the command.
  const kept = redactArgs("--password hunter2 start");
  assert.ok(kept.includes("(redacted)") && kept.includes("start"), kept);
});

test("diff_text caps huge inputs instead of OOMing", async () => {
  const big = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");
  const out = await diffTextTool.execute({ left: big, right: big + "\nextra" }, ctx(process.cwd()));
  assert.ok(out.includes("input truncated"), `expected truncation note, got: ${out.slice(0, 200)}`);
  assert.ok(out.length < 10_000, "output stays bounded");
});
