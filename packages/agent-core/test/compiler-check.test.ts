import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCompilerErrors, checkCompilerErrorsTool } from "../src/tools/compiler-check.js";
import type { DiagnosticItem } from "../src/types.js";

test("extractCompilerErrors filters out npm noise and retains compiler errors", () => {
  const rawOutput = `
> my-pkg@1.0.0 typecheck
> tsc --noEmit

src/foo.ts:15:3 - error TS2322: Type 'string' is not assignable to type 'number'.
15   count: "123",
     ~~~~~

npm error Lifecycle script \`typecheck\` failed with error:
npm error code 2
`;

  const filtered = extractCompilerErrors(rawOutput);
  assert.ok(filtered.includes("error TS2322"));
  assert.ok(filtered.includes("src/foo.ts:15:3"));
  assert.ok(!filtered.includes("npm error"));
});

test("checkCompilerErrorsTool utilizes ctx.getDiagnostics when available", async () => {
  const mockDiags: DiagnosticItem[] = [
    {
      path: "/workspace/src/foo.ts",
      line: 12,
      character: 5,
      severity: "error",
      message: "Cannot find name 'bar'.",
      source: "ts",
    },
  ];

  const res = await checkCompilerErrorsTool.execute(
    {},
    {
      cwd: "/workspace",
      todos: [],
      getDiagnostics: async () => mockDiags,
    },
  );

  assert.ok(res.includes("Cannot find name 'bar'"));
  assert.ok(res.includes("src/foo.ts"));
});

test("checkCompilerErrorsTool returns clean success when getDiagnostics has zero errors", async () => {
  const res = await checkCompilerErrorsTool.execute(
    {},
    {
      cwd: "/workspace",
      todos: [],
      getDiagnostics: async () => [],
    },
  );

  assert.ok(res.includes("No compiler or diagnostic errors found"));
});
