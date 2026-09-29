import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diagnoseTurnEnd,
  unfinishedTurnCode,
  unfinishedTurnNotice,
  unfinishedTurnNudge,
  type UnfinishedTurn,
} from "../src/continuation.js";

/**
 * The heuristic decides whether a turn that ended without a tool call was a real
 * answer. Wrongly saying "unfinished" costs one extra request; wrongly saying
 * "finished" is the bug being fixed. But a wrong "unfinished" on a *question*
 * would make the agent barrel past a confirmation the user was owed, so the
 * negative table matters as much as the positive one.
 */

const UNFINISHED: string[] = [
  // The strongest signal: a colon or ellipsis promises something that never came.
  "Let me check the config file:",
  "Here is the plan:",
  "Checking the logs…",
  "Looking into it...",
  "**Next step:**",
  "I found the cause in the loader. Now let me read the config file:",
  // Announced work, stated as a full sentence.
  "Now I'll run the tests.",
  "I found the issue. Let me fix it.",
  "Okay, let me look at how the loader works.",
  "First, I need to read the file.",
  "I'll start by reading the entry point.",
  "I'll go ahead and update the tests.",
  "Let's run the build.",
  "Let me take a closer look.",
  "Let me double-check the migration.",
  // Progress narration in the gerund.
  "Searching for that error message.",
  "Looking at the config.",
  // Chinese.
  "让我检查一下配置文件",
  "接下来我来运行测试。",
  "好的，我先看一下这个文件：",
];

const FINISHED: string[] = [
  "Done.",
  "All done. The tests pass.",
  "I fixed the off-by-one in `pager.ts` and added a regression test.",
  "The bug was in the loader: it read the config before the env was set.\n\n- Fixed `loader.ts`\n- Added a test",
  // Handing control back to the user is deliberate, not a stall.
  "Want me to also update the docs?",
  "Should I proceed with the refactor?",
  "Which approach do you prefer:",
  "Please confirm which option you prefer:",
  "All done — let me know if you want anything else.",
  "I've made the change. If you'd like, I can also add a changelog entry.",
  "Before I proceed, do you want the old endpoint kept?",
  "Waiting for your go-ahead.",
  "是否需要我继续处理其他文件？",
  // Sign-offs that share words with promises but promise nothing.
  "I'll leave the rest to you.",
  "I'll be here if you need me.",
  // A closed code block ends an answer, not a sentence.
  "Here is the fix:\n\n```ts\nconst x = 1;\n```",
  // ...even when the last line inside the block ends in a colon or an ellipsis
  // (Python blocks, truncated command output), which would otherwise look like a promise.
  "The output was:\n\n```\nRunning tests...\n```",
  "Use a guard clause:\n\n```python\ndef handle(x):\n    if not x:\n```",
  // A question asked earlier does not excuse an announcement at the end...
  // (covered in UNFINISHED_AFTER_QUESTION below), but a question at the end does.
  "I checked both. Does that match what you expected?",
];

test("turns that end by promising work are flagged as announced", () => {
  for (const text of UNFINISHED) {
    const turn = diagnoseTurnEnd(text);
    assert.equal(turn?.kind, "announced", `should be flagged: ${JSON.stringify(text)}`);
  }
});

test("real answers, questions and sign-offs are left alone", () => {
  for (const text of FINISHED) {
    assert.equal(diagnoseTurnEnd(text), null, `must not be flagged: ${JSON.stringify(text)}`);
  }
});

test("a question earlier in the message does not excuse a trailing announcement", () => {
  // Only the last sentence decides: the model asked, carried on regardless, and stopped.
  const turn = diagnoseTurnEnd("Is the port configurable? It seems so. Let me read the config file:");
  assert.equal(turn?.kind, "announced");
});

test("an empty or whitespace-only reply is its own kind", () => {
  assert.deepEqual(diagnoseTurnEnd(""), { kind: "empty" });
  assert.deepEqual(diagnoseTurnEnd("  \n\t "), { kind: "empty" });
});

test("the quoted tail is short, single-line and taken from the end of the message", () => {
  const long = `${"padding ".repeat(80)}\n\nand finally,\nlet me check the file:`;
  const turn = diagnoseTurnEnd(long);
  assert.equal(turn?.kind, "announced");
  if (turn?.kind !== "announced") return;
  assert.ok(turn.tail.length <= 160);
  assert.doesNotMatch(turn.tail, /\n/);
  assert.match(turn.tail, /let me check the file:$/);
});

test("each kind has a nudge the model can act on, a notice for the UI, and a stable event code", () => {
  const turns: UnfinishedTurn[] = [{ kind: "empty" }, { kind: "announced", tail: "let me check the file:" }];
  for (const turn of turns) {
    assert.match(unfinishedTurnNudge(turn), /^\[continue\] /);
    assert.ok(unfinishedTurnNotice(turn).length > 0);
  }
  assert.match(unfinishedTurnNudge({ kind: "announced", tail: "let me check the file:" }), /let me check the file:/);
  assert.equal(unfinishedTurnCode({ kind: "empty" }), "empty_response");
  assert.equal(unfinishedTurnCode({ kind: "announced", tail: "x" }), "unfinished_turn");
});
