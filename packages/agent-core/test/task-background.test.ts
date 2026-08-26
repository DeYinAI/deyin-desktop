import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentDefinition } from "../src/capabilities/subagents.js";
import { createTaskTool } from "../src/tools/task.js";

const DEF: SubagentDefinition = {
  name: "explorer",
  description: "Explore the codebase",
  prompt: "You explore codebases.",
  source: "builtin",
  isBackground: true,
  readonly: true,
};

test("background task returns job_id when onBackgroundStart is wired", async () => {
  const tool = createTaskTool({
    subagents: [DEF],
    runSubagent: async () => ({ ok: true, report: "done" }),
    onBackgroundStart: () => "job-123",
    onBackgroundDone: () => undefined,
  });
  const result = await tool.execute(
    { subagent: "explorer", prompt: "find auth" },
    { cwd: "/tmp", todos: [], signal: new AbortController().signal },
  );
  assert.match(result, /job_id: job-123/);
});
