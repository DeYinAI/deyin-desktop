import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewPrompt,
  goalContinuation,
  goalKickoff,
  parseReviewVerdict,
  renderTranscript,
  REVIEWER_SYSTEM_PROMPT,
} from "../src/goal-reviewer.js";
import {
  describeGoal,
  goalFieldsFromCommand,
  isGoalCommand,
  matchGoalCommand,
  parseGoalCommand,
} from "../src/capabilities/goal-command.js";

/* Command surface ------------------------------------------------------------- */

test("/goal parses every command form", () => {
  assert.deepEqual(parseGoalCommand("/goal fix the build"), { kind: "set", objective: "fix the build" });
  assert.deepEqual(parseGoalCommand("/goal pause"), { kind: "pause" });
  assert.deepEqual(parseGoalCommand("/goal resume"), { kind: "resume" });
  assert.deepEqual(parseGoalCommand("/goal clear"), { kind: "clear" });
  assert.deepEqual(parseGoalCommand("/goal"), { kind: "status" });
  assert.equal(parseGoalCommand("please /goal this"), null);
  assert.equal(parseGoalCommand("/goals are fun"), null);
});

test("/goal control words are case-insensitive and quoted objectives unquote", () => {
  assert.deepEqual(parseGoalCommand("/GOAL PAUSE"), { kind: "pause" });
  assert.deepEqual(parseGoalCommand('/goal "make tests green"'), { kind: "set", objective: "make tests green" });
  assert.deepEqual(parseGoalCommand("/goal `ship it`"), { kind: "set", objective: "ship it" });
});

test("/goal caps the objective at 4000 characters", () => {
  const parsed = parseGoalCommand(`/goal ${"x".repeat(5000)}`);
  assert.equal(parsed?.kind, "set");
  if (parsed?.kind === "set") assert.equal(parsed.objective.length, 4000);
});

test("/goal with whitespace-only objective reports status instead of clearing", () => {
  assert.deepEqual(parseGoalCommand('/goal "  "'), { kind: "status" });
});

test("matchGoalCommand keeps its legacy string contract", () => {
  assert.equal(matchGoalCommand("/goal do the thing"), "do the thing");
  assert.equal(matchGoalCommand("/goal pause"), null);
  assert.equal(matchGoalCommand("just chatting"), undefined);
  assert.equal(isGoalCommand("/goal x"), true);
  assert.equal(isGoalCommand("/goalx"), false);
});

test("goalFieldsFromCommand starts a goal at round zero with an id and boot", () => {
  const fields = goalFieldsFromCommand("ship it", { id: "g1", boot: "b1", maxRounds: 10 });
  assert.equal(fields?.text, "ship it");
  assert.equal(fields?.status, "active");
  assert.equal(fields?.rounds, 0);
  assert.equal(fields?.id, "g1");
  assert.equal(fields?.boot, "b1");
  assert.equal(fields?.maxRounds, 10);
  assert.ok(fields?.updatedAt);
  assert.equal(goalFieldsFromCommand(null), undefined);
});

test("describeGoal reports status, rounds and the last reviewer note", () => {
  assert.match(describeGoal(undefined), /No goal is set/);
  const line = describeGoal({ text: "ship it", status: "paused", rounds: 3, maxRounds: 10, reason: "blocked on creds" });
  assert.match(line, /paused/);
  assert.match(line, /3\/10 rounds/);
  assert.match(line, /blocked on creds/);
});

/* Reviewer verdict parsing ---------------------------------------------------- */

test("parseReviewVerdict accepts a bare JSON object", () => {
  const parsed = parseReviewVerdict('{"verdict":"done","reason":"tests pass"}');
  assert.deepEqual(parsed, { verdict: "done", reason: "tests pass" });
});

test("parseReviewVerdict tolerates a fenced reply with prose around it", () => {
  const parsed = parseReviewVerdict(
    'Here is my verdict:\n```json\n{"verdict":"continue","reason":"step 2 remains","next":"run the migration"}\n```\nThanks.',
  );
  assert.equal(parsed?.verdict, "continue");
  assert.equal(parsed?.next, "run the migration");
});

test("parseReviewVerdict rejects unknown verdicts instead of guessing", () => {
  assert.equal(parseReviewVerdict('{"verdict":"looks_good","reason":"x"}'), null);
  assert.equal(parseReviewVerdict("I think it is done"), null);
  assert.equal(parseReviewVerdict('{"reason":"no verdict"}'), null);
  assert.equal(parseReviewVerdict(""), null);
});

test("parseReviewVerdict normalizes case and supplies a reason when missing", () => {
  const parsed = parseReviewVerdict('{"verdict":"DONE"}');
  assert.equal(parsed?.verdict, "done");
  assert.equal(parsed?.reason, "No reason given.");
});

test("every verdict the reviewer may return is accepted", () => {
  for (const verdict of ["done", "continue", "blocked", "paused", "wait"]) {
    assert.equal(parseReviewVerdict(`{"verdict":"${verdict}","reason":"r"}`)?.verdict, verdict);
  }
});

/* Review request building ----------------------------------------------------- */

test("the reviewer is told it has no tools and must answer one JSON object", () => {
  assert.match(REVIEWER_SYSTEM_PROMPT, /do not use tools/i);
  assert.match(REVIEWER_SYSTEM_PROMPT, /one JSON object/i);
  for (const verdict of ["done", "continue", "blocked", "paused", "wait"]) {
    assert.match(REVIEWER_SYSTEM_PROMPT, new RegExp(`"${verdict}"`));
  }
});

test("buildReviewPrompt carries the objective, rounds and transcript", () => {
  const prompt = buildReviewPrompt({
    apiBaseUrl: "http://x",
    token: "t",
    model: "m",
    objective: "make the build pass",
    messages: [
      { role: "user", content: "please build" },
      { role: "assistant", content: "running", toolCalls: [{ id: "c1", name: "bash", arguments: '{"command":"pnpm build"}' }] },
      { role: "tool", toolCallId: "c1", toolName: "bash", content: "BUILD OK" },
    ],
    rounds: 2,
    maxRounds: 10,
  });
  assert.match(prompt, /make the build pass/);
  assert.match(prompt, /2 of 10 used/);
  assert.match(prompt, /TOOL CALL bash/);
  assert.match(prompt, /BUILD OK/);
});

test("buildReviewPrompt lists background shells and notes a running subagent", () => {
  const prompt = buildReviewPrompt({
    apiBaseUrl: "http://x",
    token: "t",
    model: "m",
    objective: "ship it",
    messages: [],
    backgroundShells: ["pnpm dev"],
    backgroundSubagentRunning: true,
  });
  assert.match(prompt, /pnpm dev/);
  assert.match(prompt, /background subagent/i);
});

test("renderTranscript skips system messages and renders every other role", () => {
  const text = renderTranscript([
    { role: "system", content: "SECRET SYSTEM PROMPT" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "there", toolCalls: [{ id: "c", name: "read", arguments: "{}" }] },
    { role: "tool", toolCallId: "c", toolName: "read", content: "file body" },
  ]);
  assert.ok(!text.includes("SECRET SYSTEM PROMPT"), "system prompt is not echoed to the reviewer");
  assert.match(text, /USER: hi/);
  assert.match(text, /ASSISTANT: there/);
  assert.match(text, /TOOL CALL read/);
  assert.match(text, /file body/);
});

test("renderTranscript elides oversized content from both ends", () => {
  const huge = `HEAD${"x".repeat(9000)}TAIL`;
  const text = renderTranscript([{ role: "user", content: huge }]);
  assert.ok(text.length < huge.length, "long content is compressed");
  assert.match(text, /HEAD/);
  assert.match(text, /TAIL/);
  assert.match(text, /chars elided/);
});

/* Continuation + kickoff ------------------------------------------------------ */

test("goalContinuation wraps the objective as untrusted data", () => {
  const text = goalContinuation({ objective: "make tests pass", reason: "one test fails", next: "fix parser", rounds: 2, maxRounds: 10 });
  assert.match(text, /<untrusted_objective>/);
  assert.match(text, /make tests pass/);
  assert.match(text, /<\/untrusted_objective>/);
  assert.match(text, /Round 2 of 10/);
  assert.match(text, /one test fails/);
  assert.match(text, /fix parser/);
});

test("goalKickoff wraps the objective as untrusted data and names the reviewer", () => {
  const text = goalKickoff("ship the feature");
  assert.match(text, /<untrusted_objective>/);
  assert.match(text, /ship the feature/);
  assert.match(text, /reviewer/i);
});
