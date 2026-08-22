import assert from "node:assert/strict";
import test from "node:test";
import { PermissionEngine } from "@deyin/agent-core";
import {
  AUTOMATION_NEVER_SKIP_PREFIXES,
  AUTOMATION_NEVER_SKIP_TOOLS,
  automationRequiresExtraConfirmation,
} from "../src/main/permission-policy.js";
import { PayloadResolutionError, resolvePayload, skillPrompt } from "../src/main/automations/payload.js";
import { buildRemoteRunCommand, buildRemoteStdin, mapCliEvent } from "../src/main/automations/cli-invocation.js";

const skill = {
  name: "threat-model",
  description: "Model threats",
  path: "/w/.deyin/skills/threat-model/SKILL.md",
  source: "workspace",
  disableModelInvocation: false,
};

const subagent = {
  name: "reviewer",
  description: "Reviews a diff",
  prompt: "You review.",
  readonly: true,
  isBackground: false,
  source: "workspace",
};

/* Payload resolution ------------------------------------------------------- */

test("prompt payload passes through untouched", () => {
  const out = resolvePayload({ kind: "prompt", prompt: "do the thing" }, {
    skills: [],
    subagents: [],
    canDelegateInProcess: true,
  });
  assert.equal(out.prompt, "do the thing");
  assert.equal(out.subagent, undefined);
});

test("skill payload points the agent at the SKILL.md path", () => {
  const out = resolvePayload({ kind: "skill", skill: "threat-model", input: "the auth module" }, {
    skills: [skill],
    subagents: [],
    canDelegateInProcess: true,
  });
  assert.ok(out.prompt.includes(skill.path));
  assert.ok(out.prompt.includes("the auth module"));
  assert.equal(out.prompt, skillPrompt(skill, "the auth module"));
});

test("skill payload resolves even when the skill is model-invocation-disabled", () => {
  // Naming a skill in an automation is an explicit invocation, like /name.
  const hidden = { ...skill, disableModelInvocation: true };
  const out = resolvePayload({ kind: "skill", skill: "threat-model" }, {
    skills: [hidden],
    subagents: [],
    canDelegateInProcess: true,
  });
  assert.ok(out.prompt.includes(hidden.path));
});

test("a missing or disabled capability fails the run loudly", () => {
  assert.throws(
    () => resolvePayload({ kind: "skill", skill: "gone" }, { skills: [], subagents: [], canDelegateInProcess: true }),
    PayloadResolutionError,
  );
  assert.throws(
    () => resolvePayload({ kind: "subagent", subagent: "gone" }, { skills: [], subagents: [], canDelegateInProcess: false }),
    PayloadResolutionError,
  );
});

test("subagent payload delegates in-process locally, by prompt remotely", () => {
  const local = resolvePayload({ kind: "subagent", subagent: "reviewer", input: "HEAD~1" }, {
    skills: [],
    subagents: [subagent],
    canDelegateInProcess: true,
  });
  assert.equal(local.subagent?.name, "reviewer");
  assert.equal(local.prompt, "HEAD~1");

  const remote = resolvePayload({ kind: "subagent", subagent: "reviewer", input: "HEAD~1" }, {
    skills: [],
    subagents: [subagent],
    canDelegateInProcess: false,
  });
  assert.equal(remote.subagent, undefined);
  assert.ok(remote.prompt.includes("reviewer"));
  assert.ok(remote.prompt.includes("HEAD~1"));
});

/* Unattended permissions --------------------------------------------------- */

function automationEngine(): PermissionEngine {
  return new PermissionEngine({
    agentRules: [{ tool: "chrome_navigate", action: "ask" }],
    configRules: [],
    skipAll: true,
    neverSkipTools: AUTOMATION_NEVER_SKIP_TOOLS,
    neverSkipPrefixes: AUTOMATION_NEVER_SKIP_PREFIXES,
  });
}

test("skipAll does not auto-allow computer-use in an unattended run", () => {
  const engine = automationEngine();
  // Ordinary tools are auto-allowed; that is the point of an unattended run.
  assert.equal(engine.actionFor({ name: "read", tier: "read" } as never), "allow");
  // OS input synthesis and browser navigation must still reach the resolver,
  // which denies them — there is no user to answer a prompt.
  assert.notEqual(engine.actionFor({ name: "computer_click", tier: "write" } as never), "allow");
  assert.notEqual(engine.actionFor({ name: "chrome_navigate", tier: "write" } as never), "allow");
});

test("high-risk computer-use intent is classified for denial", () => {
  assert.equal(automationRequiresExtraConfirmation("computer_launch_app", { app: "Notepad" }), true);
  assert.equal(automationRequiresExtraConfirmation("computer_type", { text: "confirm purchase" }), true);
  assert.equal(automationRequiresExtraConfirmation("read", { path: "a.txt" }), false);
});

/* CLI invocation (WSL + SSH share this) ------------------------------------ */

test("the token and prompt never reach the remote argv", () => {
  const command = buildRemoteRunCommand({ workspacePath: "/home/me/proj", model: "GLM-5.2" });
  const stdin = buildRemoteStdin({ token: "secret-token", prompt: "secret prompt" });

  assert.equal(command.includes("secret-token"), false);
  assert.equal(command.includes("secret prompt"), false);
  // Both travel base64 over stdin instead.
  assert.ok(stdin.startsWith(Buffer.from("secret-token", "utf8").toString("base64")));
  assert.ok(stdin.includes(Buffer.from("secret prompt", "utf8").toString("base64")));
});

test("the remote command traps signals so no deyin child is orphaned", () => {
  const command = buildRemoteRunCommand({ workspacePath: "/home/me/proj", model: "m" });
  assert.ok(command.includes("set -m"));
  // The whole script is single-quoted for `bash -lc`, so the trap's own quotes
  // arrive escaped; assert on the parts that survive that wrapping.
  assert.ok(command.includes("trap "));
  assert.ok(command.includes("kill -TERM -$$ 2>/dev/null"));
  assert.ok(command.includes("EXIT HUP INT TERM"));
});

test("a workspace path with a quote cannot break out of the shell command", () => {
  const command = buildRemoteRunCommand({ workspacePath: "/tmp/it's here", model: "m" });
  assert.equal(command.includes("'; rm"), false);
  assert.ok(command.includes(`'\\''`));
});

test("oversized tool results are truncated before they reach run history", () => {
  const mapped = mapCliEvent({
    type: "tool-end",
    call: { id: "1", name: "bash" },
    result: "x".repeat(20_000),
    ok: true,
    denied: false,
  } as never);
  assert.equal(mapped?.type, "tool-end");
  assert.ok(mapped && "result" in mapped && mapped.result.length < 9_000);
  assert.ok(mapped && "result" in mapped && mapped.result.endsWith("… (truncated)"));
});
