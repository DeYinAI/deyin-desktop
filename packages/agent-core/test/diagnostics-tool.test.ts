import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticsTool } from "../src/tools/diagnostics.js";
import type { ToolContext } from "../src/types.js";

const EMPTY_CTX: ToolContext = {
  cwd: "/mock",
  todos: [],
};

test("diagnostics tool returns message when no diagnostics provider configured", async () => {
  const res = await diagnosticsTool.execute({}, EMPTY_CTX);
  assert.match(res, /No active language server or compiler diagnostics provider/);

  const fileRes = await diagnosticsTool.execute({ path: "src/main.ts" }, EMPTY_CTX);
  assert.match(fileRes, /No active language server or compiler diagnostics provider configured for "src\/main.ts"/);
});

test("diagnostics tool queries diagnostics for specific path and formats errors", async () => {
  const ctxWithDiag: ToolContext = {
    cwd: "/mock",
    todos: [],
    getDiagnostics: async (paths) => {
      assert.deepEqual(paths, ["src/app.ts"]);
      return [
        {
          path: "src/app.ts",
          line: 10,
          character: 4,
          severity: "error",
          message: "Cannot find name 'foo'.",
          source: "ts",
        },
      ];
    },
  };

  const res = await diagnosticsTool.execute({ path: "src/app.ts" }, ctxWithDiag);
  assert.match(res, /- src\/app.ts:10:4: \[ERROR\] Cannot find name 'foo'\. \[ts\]/);
});

test("diagnostics tool reports clean status when no errors found", async () => {
  const ctxClean: ToolContext = {
    cwd: "/mock",
    todos: [],
    getDiagnostics: async () => [],
  };

  const res = await diagnosticsTool.execute({ path: "src/clean.ts" }, ctxClean);
  assert.equal(res, 'No diagnostic errors or warnings found in "src/clean.ts".');

  const wsRes = await diagnosticsTool.execute({}, ctxClean);
  assert.equal(wsRes, "No diagnostic errors or warnings found in the workspace.");
});

test("diagnostics tool handles provider exceptions gracefully", async () => {
  const ctxErr: ToolContext = {
    cwd: "/mock",
    todos: [],
    getDiagnostics: async () => {
      throw new Error("LSP server unreachable");
    },
  };

  const res = await diagnosticsTool.execute({}, ctxErr);
  assert.match(res, /Diagnostics provider failed: LSP server unreachable/);
});
