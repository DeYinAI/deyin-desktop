import assert from "node:assert/strict";
import test from "node:test";
import {
  matchCommand,
  resolveCommandInvocation,
  unknownCommandMessage,
} from "../../../agent-core/src/capabilities/commands.js";

/** Mirrors desktop/web host early-abort when resolveCommandInvocation returns unknown. */
function resolveSlashOrError(
  prompt: string,
  caps: { commands: { name: string; body: string }[]; skills: { name: string; path: string }[] },
): { prompt: string } | { error: string } {
  const resolved = resolveCommandInvocation(prompt, caps);
  if (resolved.kind === "unknown") {
    return { error: unknownCommandMessage(resolved.name, resolved.suggestions) };
  }
  if (resolved.kind === "none") return { prompt };
  return { prompt: resolved.prompt };
}

test("isUnknownSlash: unrecognised /name resolves to unknown with suggestions", () => {
  const caps = {
    commands: [{ name: "commit", body: "Commit: $ARGUMENTS" }],
    skills: [{ name: "review-bugbot", path: "/skills/review-bugbot/SKILL.md" }],
  };

  const resolved = resolveCommandInvocation("/commmit fix things", caps);
  assert.equal(resolved.kind, "unknown");
  if (resolved.kind !== "unknown") return;
  assert.equal(resolved.name, "commmit");
  assert.deepEqual(resolved.suggestions, ["commit"]);
});

test("host behavior: unknown slash aborts with user-facing error, not model prose", () => {
  const caps = { commands: [{ name: "fix", body: "Fix it: $ARGUMENTS" }], skills: [] };
  const outcome = resolveSlashOrError("/does-not-exist", caps);
  assert.ok("error" in outcome);
  if (!("error" in outcome)) return;
  assert.match(outcome.error, /Unknown command/);
  assert.match(outcome.error, /Type `\//);
});

test("absolute paths are not treated as slash commands", () => {
  const caps = { commands: [{ name: "commit", body: "x" }], skills: [] };
  assert.equal(matchCommand("/home/me/notes.md is stale"), null);
  assert.deepEqual(resolveCommandInvocation("/home/me/notes.md is stale", caps), { kind: "none" });
  assert.deepEqual(resolveSlashOrError("/home/me/notes.md is stale", caps), {
    prompt: "/home/me/notes.md is stale",
  });
});

test("known commands and skills expand instead of hitting unknown", () => {
  const caps = {
    commands: [{ name: "explain", body: "Explain: $ARGUMENTS" }],
    skills: [{ name: "deploy", path: "/ws/.deyin/skills/deploy/SKILL.md" }],
  };

  const command = resolveSlashOrError("/explain the diff", caps);
  assert.ok("prompt" in command);
  if (!("prompt" in command)) return;
  assert.match(command.prompt, /Explain:/);

  const skill = resolveSlashOrError("/deploy prod", caps);
  assert.ok("prompt" in skill);
  if (!("prompt" in skill)) return;
  assert.match(skill.prompt, /deploy\/SKILL.md/);
});
