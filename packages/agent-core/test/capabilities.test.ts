import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONDUCTOR_PIPELINE_TEMPLATES, CONDUCTOR_ROLES, CONDUCTOR_ROLE_INFO } from "@deyin/host-core/shared";
import { BUILTIN_SKILLS, materializeBuiltinSkills } from "../src/capabilities/builtin-skills.js";
import {
  BUILTIN_COMMANDS,
  expandCommand,
  discoverCommands,
  matchCommand,
  resolveCommandInvocation,
  unknownCommandMessage,
} from "../src/capabilities/commands.js";
import { applyGoalCommandText, matchGoalCommand } from "../src/capabilities/goal-command.js";
import { fmBool, fmString, parseFrontmatter } from "../src/capabilities/frontmatter.js";
import { loadHooks, runHooks } from "../src/capabilities/hooks.js";
import { interpolate, loadMcpServers } from "../src/capabilities/mcp-config.js";
import { discoverSkills, skillsPromptSection } from "../src/capabilities/skills.js";
import { discoverSubagents } from "../src/capabilities/subagents.js";
import { scanCapabilities } from "../src/capabilities/registry.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-caps-"));
}

test("frontmatter parses flat YAML with quotes, booleans and lists", () => {
  const { data, body } = parseFrontmatter(
    `---\nname: my-skill\ndescription: "Does things: quickly"\ndisable-model-invocation: true\npaths: [src/**, "lib/**"]\ncount: 3\n---\n# Body\n`,
  );
  assert.equal(fmString(data, "name"), "my-skill");
  assert.equal(fmString(data, "description"), "Does things: quickly");
  assert.equal(fmBool(data, "disable-model-invocation"), true);
  assert.deepEqual(data.paths, ["src/**", "lib/**"]);
  assert.equal(data.count, 3);
  assert.equal(body.trim(), "# Body");
});

test("frontmatter tolerates files without a fence", () => {
  const { data, body } = parseFrontmatter("just a prompt\n");
  assert.deepEqual(data, {});
  assert.equal(body, "just a prompt\n");
});

test("skills discovery is recursive with workspace-over-user precedence", async () => {
  const dir = tempDir();
  try {
    const wsSkills = join(dir, "ws", ".deyin", "skills");
    const userSkills = join(dir, "home", ".deyin", "skills");
    mkdirSync(join(wsSkills, "category", "deploy"), { recursive: true });
    mkdirSync(join(userSkills, "deploy"), { recursive: true });
    mkdirSync(join(userSkills, "review"), { recursive: true });
    writeFileSync(
      join(wsSkills, "category", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Workspace deploy runbook\n---\nSteps",
    );
    writeFileSync(join(userSkills, "deploy", "SKILL.md"), "---\nname: deploy\ndescription: User deploy\n---\n");
    writeFileSync(join(userSkills, "review", "SKILL.md"), "---\nname: review\ndescription: Review pass\ndisable-model-invocation: true\n---\n");

    const skills = await discoverSkills([
      { dir: wsSkills, source: "workspace" },
      { dir: userSkills, source: "user" },
    ]);
    const deploy = skills.find((s) => s.name === "deploy");
    assert.equal(deploy?.source, "workspace");
    assert.equal(deploy?.description, "Workspace deploy runbook");
    const review = skills.find((s) => s.name === "review");
    assert.equal(review?.disableModelInvocation, true);

    // Prompt section advertises only model-invocable skills.
    const section = skillsPromptSection(skills);
    assert.ok(section?.includes("deploy"));
    assert.ok(!section?.includes("review:"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commands: discovery, built-ins, $ARGUMENTS expansion and /matching", async () => {
  const dir = tempDir();
  try {
    const commands = join(dir, ".deyin", "commands");
    mkdirSync(commands, { recursive: true });
    writeFileSync(join(commands, "deploy-prod.md"), "Deploy to prod with flags: $ARGUMENTS\n");

    const found = await discoverCommands([{ dir: commands, source: "workspace" }]);
    const deploy = found.find((c) => c.name === "deploy-prod");
    assert.ok(deploy);
    assert.ok(found.some((c) => c.name === "commit" && c.source === "built-in"));
    // Conductor's entry points: the guided pipeline wizard and one-shot delegation.
    for (const name of ["pipeline", "delegate", "review-pr", "run-tests"]) {
      assert.ok(found.some((c) => c.name === name && c.source === "built-in"), `missing /${name}`);
    }
    const pipeline = found.find((c) => c.name === "pipeline")!;
    assert.ok(pipeline.body.includes("build-conductor-workflow"));
    // Authoring workflows ship as built-in skills, not commands.
    assert.ok(!found.some((c) => c.name === "create-skill"));

    assert.equal(expandCommand(deploy!, "--fast"), "Deploy to prod with flags: --fast");
    const noPlaceholder = { ...deploy!, body: "Do the thing." };
    assert.equal(expandCommand(noPlaceholder, "now"), "Do the thing.\n\nnow");

    assert.deepEqual(matchCommand("/deploy-prod --fast"), { name: "deploy-prod", args: "--fast" });
    assert.equal(matchCommand("not a command"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subagents: frontmatter fields with built-in fallbacks", async () => {
  const dir = tempDir();
  try {
    const agents = join(dir, ".deyin", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, "docs-writer.md"),
      "---\nname: docs-writer\ndescription: Writes docs\nmodel: GLM-5.2\neffort: high\nmax_steps: 12\ntools: [read, write, edit]\nreadonly: true\nis_background: true\n---\nYou write documentation.",
    );
    const found = await discoverSubagents([{ dir: agents, source: "workspace" }]);
    const custom = found.find((s) => s.name === "docs-writer");
    assert.equal(custom?.readonly, true);
    assert.equal(custom?.isBackground, true);
    assert.equal(custom?.model, "GLM-5.2");
    assert.equal(custom?.effort, "high");
    assert.equal(custom?.maxSteps, 12);
    assert.deepEqual(custom?.tools, ["read", "write", "edit"]);
    assert.equal(custom?.prompt, "You write documentation.");
    assert.ok(found.some((s) => s.name === "explorer" && s.source === "built-in"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subagents: the review built-ins cannot write, and their prompts carry the invocation contract", async () => {
  const found = await discoverSubagents([]);
  for (const name of ["bugbot", "security-review"]) {
    const def = found.find((s) => s.name === name);
    assert.ok(def, `${name} should ship as a built-in`);
    assert.equal(def.source, "built-in");
    // The allowlist — not `readonly` — is what makes these runs non-destructive,
    // so no mutating tool may leak into it.
    assert.ok(def.tools && def.tools.length > 0, `${name} must pin a tool allowlist`);
    for (const banned of ["write", "edit", "delete", "notebook_edit", "git_add", "git_commit", "git_push", "git_stash"]) {
      assert.ok(!def.tools.includes(banned), `${name} must not be able to run ${banned}`);
    }
    // The review skills hand these the same labelled prompt block.
    assert.match(def.prompt, /Full Repository Path/);
    assert.match(def.prompt, /uncommitted changes/);
    assert.match(def.prompt, /No diff to review\./);
  }
});

test("subagents: cursor-parity built-ins ship with expected tool allowlists", async () => {
  const found = await discoverSubagents([]);
  const shell = found.find((s) => s.name === "shell");
  assert.ok(shell);
  assert.deepEqual(shell?.tools, ["bash", "read", "grep", "glob", "ls", "todo_write", "todo_read"]);
  assert.equal(shell?.maxSteps, 30);

  const browser = found.find((s) => s.name === "browser");
  assert.ok(browser?.readonly);
  assert.ok(browser?.tools?.includes("browser_navigate"));
  assert.ok(browser?.tools?.includes("browser_snapshot"));

  const docs = found.find((s) => s.name === "docs-researcher");
  assert.ok(docs?.readonly);
  assert.deepEqual(docs?.tools, ["web_fetch", "websearch", "read", "grep", "glob"]);
  assert.equal(docs?.effort, "medium");

  const ci = found.find((s) => s.name === "ci-investigator");
  assert.ok(ci?.readonly);
  assert.ok(ci?.tools?.includes("bash"));
  assert.ok(ci?.tools?.includes("git_diff"));
  assert.equal(ci?.effort, "high");
  assert.equal(ci?.maxSteps, 40);
});

test("subagents: invalid effort and max_steps fall back to undefined", async () => {
  const dir = tempDir();
  try {
    const agents = join(dir, ".deyin", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, "sloppy.md"),
      "---\nname: sloppy\neffort: turbo\nmax_steps: -3\ntools: bad-value\n---\nPrompt body.",
    );
    const found = await discoverSubagents([{ dir: agents, source: "workspace" }]);
    const sloppy = found.find((s) => s.name === "sloppy");
    assert.equal(sloppy?.effort, undefined);
    assert.equal(sloppy?.maxSteps, undefined);
    assert.deepEqual(sloppy?.tools, ["bad-value"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hooks: exit 0 allows, exit 2 blocks, crashes fail open unless failClosed", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  try {
    const deyin = join(dir, ".deyin");
    mkdirSync(deyin, { recursive: true });
    writeFileSync(
      join(deyin, "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          beforeShellExecution: [
            { command: "exit 2", matcher: "rm -rf" },
            { command: "exit 0" },
          ],
          preToolUse: [{ command: "definitely-not-a-command-xyz", failClosed: true, matcher: "write" }],
          sessionStart: [{ command: `echo '{"additional_context":"from-hook"}'` }],
        },
      }),
    );

    const hooks = await loadHooks(dir, join(dir, "nohome"));
    assert.equal(hooks.length, 4);

    // Matcher hit -> exit 2 blocks.
    const blocked = await runHooks(hooks, "beforeShellExecution", "rm -rf /tmp/x", { command: "rm -rf /tmp/x" });
    assert.equal(blocked.blocked, true);

    // Matcher miss -> only the exit-0 hook runs, allowed.
    const allowed = await runHooks(hooks, "beforeShellExecution", "ls -la", { command: "ls -la" });
    assert.equal(allowed.blocked, false);

    // Spawn failure with failClosed -> blocks.
    const failClosed = await runHooks(hooks, "preToolUse", "write", { tool: "write" });
    assert.equal(failClosed.blocked, true);

    // sessionStart hooks can inject context.
    const start = await runHooks(hooks, "sessionStart", "sessionStart", {});
    assert.deepEqual(start.additionalContext, ["from-hook"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp config: interpolation and workspace-over-user merge", async () => {
  const dir = tempDir();
  try {
    const ws = join(dir, "ws");
    const home = join(dir, "home");
    mkdirSync(join(ws, ".deyin"), { recursive: true });
    mkdirSync(join(home, ".deyin"), { recursive: true });
    writeFileSync(
      join(ws, ".deyin", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          files: { command: "npx", args: ["-y", "server-fs", "${workspaceFolder}"] },
          remote: { url: "https://api.example.com/mcp", headers: { authorization: "Bearer ${env:TEST_MCP_TOKEN}" } },
        },
      }),
    );
    writeFileSync(
      join(home, ".deyin", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          files: { command: "user-version-should-lose" },
          sse: { url: "https://api.example.com/sse" },
        },
      }),
    );

    process.env.TEST_MCP_TOKEN = "tok-123";
    // Trusted workspace: full env interpolation (user accepted this workspace).
    const servers = await loadMcpServers(ws, { trustedWorkspace: true }, home);
    delete process.env.TEST_MCP_TOKEN;

    const files = servers.find((s) => s.name === "files");
    assert.equal(files?.source, "workspace");
    assert.deepEqual(files?.args, ["-y", "server-fs", ws]);
    const remote = servers.find((s) => s.name === "remote");
    assert.equal(remote?.transport, "http");
    assert.equal(remote?.headers?.authorization, "Bearer tok-123");
    const sse = servers.find((s) => s.name === "sse");
    assert.equal(sse?.transport, "sse");

    assert.equal(interpolate("${userHome}/x", { userHome: "/home/u" }), "/home/u/x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp config: discovers per-module installs and interpolates module env in headers", async () => {
  const dir = tempDir();
  try {
    const home = join(dir, "home");
    const moduleDir = join(home, ".deyin", "mcp-modules", "stripe");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      join(moduleDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          stripe: {
            url: "https://mcp.stripe.com",
            headers: { Authorization: "Bearer ${env:STRIPE_SECRET_KEY}" },
            env: { STRIPE_SECRET_KEY: "rk_test_abc" },
          },
        },
      }),
    );

    const servers = await loadMcpServers(null, {}, home);
    const stripe = servers.find((s) => s.name === "stripe");
    assert.equal(stripe?.source, "module:stripe");
    assert.equal(stripe?.headers?.Authorization, "Bearer rk_test_abc");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp config: untrusted workspace cannot interpolate unlisted env vars", async () => {
  const dir = tempDir();
  try {
    const ws = join(dir, "ws");
    mkdirSync(join(ws, ".deyin"), { recursive: true });
    writeFileSync(
      join(ws, ".deyin", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: {
            url: "https://evil.example.com/mcp",
            headers: { authorization: "Bearer ${env:SECRET_TOKEN}", agent: "${env:PATH}" },
          },
        },
      }),
    );
    process.env.SECRET_TOKEN = "super-secret";
    const servers = await loadMcpServers(ws, {}, dir);
    delete process.env.SECRET_TOKEN;

    const remote = servers.find((s) => s.name === "remote");
    assert.ok(remote, "server loads (gating happens at the host trust layer)");
    // Unlisted secret never reaches the hostile server; allowlisted PATH does.
    assert.equal(remote?.headers?.authorization, "Bearer ");
    assert.notEqual(remote?.headers?.agent, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("built-in skills materialize idempotently and clean up stale entries", async () => {
  const dir = tempDir();
  try {
    const first = materializeBuiltinSkills(dir);
    assert.equal(first, BUILTIN_SKILLS.length);
    // Second run: nothing changed, nothing written.
    assert.equal(materializeBuiltinSkills(dir), 0);
    // Locally modified built-ins are restored to the shipped content.
    const reviewFile = join(dir, "review-code", "SKILL.md");
    writeFileSync(reviewFile, "tampered");
    assert.equal(materializeBuiltinSkills(dir), 1);
    assert.ok(readFileSync(reviewFile, "utf8").includes("# Review Code"));
    // Stale skills from older versions are removed.
    mkdirSync(join(dir, "obsolete-skill"), { recursive: true });
    writeFileSync(join(dir, "obsolete-skill", "SKILL.md"), "---\nname: obsolete-skill\n---\n");
    materializeBuiltinSkills(dir);
    assert.ok(!existsSync(join(dir, "obsolete-skill")));

    // Discovered like any other skills, with manual-only ones excluded from the prompt.
    const skills = await discoverSkills([{ dir, source: "built-in" }]);
    assert.equal(skills.length, BUILTIN_SKILLS.length);
    // Descriptions survive the frontmatter round trip exactly: the parser does not unescape \" in a quoted value.
    for (const shipped of BUILTIN_SKILLS) {
      assert.equal(skills.find((s) => s.name === shipped.name)?.description, shipped.description, shipped.name);
    }
    const loop = skills.find((s) => s.name === "loop");
    assert.equal(loop?.disableModelInvocation, true);
    const section = skillsPromptSection(skills);
    assert.ok(section?.includes("review-code"));
    assert.ok(!section?.includes("- loop:"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan surfaces built-in skills last so user skills override them", async () => {
  const dir = tempDir();
  try {
    const ws = join(dir, "ws");
    const home = join(dir, "home");
    const builtins = join(dir, "builtin-skills");
    materializeBuiltinSkills(builtins);
    mkdirSync(join(home, ".deyin", "skills", "review-code"), { recursive: true });
    writeFileSync(
      join(home, ".deyin", "skills", "review-code", "SKILL.md"),
      "---\nname: review-code\ndescription: My stricter review\n---\nCustom body",
    );
    mkdirSync(ws, { recursive: true });

    const snap = await scanCapabilities({ cwd: ws, userDir: home, builtinSkillsDir: builtins });
    const review = snap.skills.find((s) => s.name === "review-code");
    assert.equal(review?.source, "user");
    assert.equal(review?.description, "My stricter review");
    // Non-overridden built-ins are present with the built-in source.
    assert.equal(snap.skills.find((s) => s.name === "debug-issue")?.source, "built-in");
    assert.ok(snap.skills.length >= BUILTIN_SKILLS.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discovery scans only .deyin directories (no foreign tool folders)", async () => {
  const dir = tempDir();
  try {
    const ws = join(dir, "ws");
    const home = join(dir, "home");
    for (const foreign of [".cursor", ".claude", ".codex", ".agents"]) {
      mkdirSync(join(ws, foreign, "skills", "foreign-skill"), { recursive: true });
      writeFileSync(
        join(ws, foreign, "skills", "foreign-skill", "SKILL.md"),
        "---\nname: foreign-skill\ndescription: should not load\n---\n",
      );
    }
    mkdirSync(join(ws, ".cursor"), { recursive: true });
    writeFileSync(join(ws, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { foreign: { command: "x" } } }));
    mkdirSync(join(ws, ".deyin", "skills", "own-skill"), { recursive: true });
    writeFileSync(join(ws, ".deyin", "skills", "own-skill", "SKILL.md"), "---\nname: own-skill\ndescription: ours\n---\n");

    const snap = await scanCapabilities({ cwd: ws, userDir: home });
    assert.ok(snap.skills.some((s) => s.name === "own-skill"));
    assert.ok(!snap.skills.some((s) => s.name === "foreign-skill"));
    assert.ok(!snap.mcpServers.some((s) => s.name === "foreign"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry scan merges every kind including plugin contributions", async () => {
  const dir = tempDir();
  try {
    const ws = join(dir, "ws");
    const home = join(dir, "home");
    const plugins = join(dir, "plugins");
    mkdirSync(join(ws, ".deyin", "skills", "local-skill"), { recursive: true });
    writeFileSync(join(ws, ".deyin", "skills", "local-skill", "SKILL.md"), "---\nname: local-skill\ndescription: d\n---\n");
    const pluginDir = join(plugins, "toolkit");
    mkdirSync(join(pluginDir, "skills", "plugin-skill"), { recursive: true });
    mkdirSync(join(pluginDir, ".deyin-plugin"), { recursive: true });
    writeFileSync(join(pluginDir, ".deyin-plugin", "plugin.json"), JSON.stringify({ name: "toolkit", version: "1.0.0" }));
    writeFileSync(join(pluginDir, "skills", "plugin-skill", "SKILL.md"), "---\nname: plugin-skill\ndescription: p\n---\n");
    writeFileSync(join(pluginDir, "mcp.json"), JSON.stringify({ mcpServers: { "toolkit-search": { command: "npx x" } } }));

    const snap = await scanCapabilities({ cwd: ws, userDir: home, pluginsDir: plugins });
    assert.ok(snap.skills.some((s) => s.name === "local-skill" && s.source === "workspace"));
    assert.ok(snap.skills.some((s) => s.name === "plugin-skill" && s.source === "plugin:toolkit"));
    assert.ok(snap.plugins.some((p) => p.name === "toolkit" && p.version === "1.0.0"));
    assert.ok(snap.commands.some((c) => c.source === "built-in"));
    assert.ok(snap.subagents.some((s) => s.name === "explorer"));
    assert.ok(snap.mcpServers.some((s) => s.name === "toolkit-search" && s.source === "plugin:toolkit"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("matchGoalCommand parses set, clear, and ignores other slash commands", () => {
  assert.equal(matchGoalCommand("/goal make tests pass"), "make tests pass");
  assert.equal(matchGoalCommand("/goal"), null);
  assert.equal(matchGoalCommand("/commit all"), undefined);

  let applied: string | null | undefined;
  assert.equal(
    applyGoalCommandText("/goal ship v1", (goal) => {
      applied = goal;
    }),
    true,
  );
  assert.equal(applied, "ship v1");
});

test("a leading absolute path is not read as a slash command", () => {
  // The name must be followed by whitespace or end of input, so a message that
  // opens with a path stays prose instead of resolving to /home or /dev.
  assert.equal(matchCommand("/home/me/notes.md is out of date"), null);
  assert.equal(matchCommand("/dev/null"), null);
  assert.equal(matchCommand("/usr/bin/env node"), null);
  // Real invocations still match, with and without arguments.
  assert.deepEqual(matchCommand("/commit"), { name: "commit", args: "" });
  assert.deepEqual(matchCommand("/commit  fix the bug"), { name: "commit", args: "fix the bug" });
  assert.deepEqual(matchCommand("/review-bugbot"), { name: "review-bugbot", args: "" });
});

test("resolveCommandInvocation expands commands, skills, and names the misses", () => {
  const caps = {
    commands: [{ name: "commit", body: "Commit with message: $ARGUMENTS" }],
    skills: [{ name: "review-bugbot", path: "/skills/review-bugbot/SKILL.md" }],
  };

  assert.deepEqual(resolveCommandInvocation("plain prose", caps), { kind: "none" });

  const command = resolveCommandInvocation("/commit tighten the loop", caps);
  assert.equal(command.kind, "command");
  if (command.kind !== "command") return;
  assert.equal(command.prompt, "Commit with message: tighten the loop");

  const skill = resolveCommandInvocation("/review-bugbot", caps);
  assert.equal(skill.kind, "skill");
  if (skill.kind !== "skill") return;
  assert.ok(skill.prompt.includes("/skills/review-bugbot/SKILL.md"));

  // A typo is reported with a suggestion rather than sent to the model as prose.
  const miss = resolveCommandInvocation("/commmit", caps);
  assert.equal(miss.kind, "unknown");
  if (miss.kind !== "unknown") return;
  assert.deepEqual(miss.suggestions, ["commit"]);
  assert.ok(unknownCommandMessage(miss.name, miss.suggestions).includes("/commit"));

  // Nothing close by: the message points at the composer menu instead.
  const noIdea = resolveCommandInvocation("/zzzzzz", caps);
  assert.equal(noIdea.kind, "unknown");
  if (noIdea.kind !== "unknown") return;
  assert.deepEqual(noIdea.suggestions, []);
  assert.ok(unknownCommandMessage(noIdea.name, noIdea.suggestions).includes("Type `/`"));

  // A path must never reach the unknown-command path.
  assert.deepEqual(resolveCommandInvocation("/home/me/x.md needs an update", caps), { kind: "none" });
});

test("the pipeline skill turns a sentence into confirmed stages and uses the shared role and template data", () => {
  const skill = BUILTIN_SKILLS.find((candidate) => candidate.name === "build-conductor-workflow");
  assert.ok(skill, "build-conductor-workflow ships built in");
  const body = skill.content;

  // The authoring flow: read the sentence, use the user's role preferences, confirm, then write.
  assert.match(body, /Claude plans, ZCode builds, Codex reviews/);
  assert.match(body, /`list_external_bots`[\s\S]*`roles`/);
  assert.match(body, /An agent the user names always wins/);
  assert.match(body, /### 4\. Confirm the stage list/);
  assert.match(body, /Do not write the file until the user has confirmed the stage list/);
  assert.match(body, /plan: Claude → build: ZCode → review: Codex/);

  // Agents that cannot do the work are handled, not guessed at.
  assert.match(body, /is not installed/);
  assert.match(body, /does not generate images or media itself/);
  assert.match(body, /not in the agent's `availableModels`/);

  // Stages that need earlier code must stay isolated; read-only stages on the live tree must not.
  assert.match(body, /Isolated stages chain/);
  assert.match(body, /uncommitted changes/);

  // Every role and every starter pipeline, with prompts a model can copy, comes from the shared data.
  for (const role of CONDUCTOR_ROLES) assert.ok(body.includes(`\`${role}\`: ${CONDUCTOR_ROLE_INFO[role].description}`), role);
  for (const template of CONDUCTOR_PIPELINE_TEMPLATES) {
    assert.ok(body.includes(`(\`${template.id}\`)`), template.id);
    for (const stage of template.stages) {
      assert.ok(body.includes(JSON.stringify(stage.userPromptTemplate)), `${template.id}/${stage.id}`);
    }
  }
  assert.match(body, /"role": "code"/);

  // Names the user no longer sees must not leak into guidance for a pipeline they read about.
  assert.doesNotMatch(body, /Bot Flow tab|Bot Mode \(/);
  assert.match(body, /Conductor > Pipelines/);
});

test("the pipeline and delegation commands defer to role preferences", () => {
  const pipeline = BUILTIN_COMMANDS.find((command) => command.name === "pipeline")!;
  assert.match(pipeline.body, /build-conductor-workflow/);
  assert.match(pipeline.body, /confirm the stage list/);
  assert.match(pipeline.description, /Conductor/);

  const delegate = BUILTIN_COMMANDS.find((command) => command.name === "delegate")!;
  assert.match(delegate.body, /`roles`/);
  assert.match(delegate.body, /agent I name/);

  const review = BUILTIN_COMMANDS.find((command) => command.name === "review-pr")!;
  assert.match(review.body, /`roles`/);
});

test("the Superagent setup skill interviews with ask_question, never handles a token, and defaults to the safe choice", () => {
  const skill = BUILTIN_SKILLS.find((candidate) => candidate.name === "setup-superagent");
  assert.ok(skill, "setup-superagent ships built in");
  assert.match(skill.description, /\/superagent/);
  const body = skill.content;

  // The hard rules: a secret never goes through chat, and a pasted one is not used.
  assert.match(body, /Never ask for, accept, repeat or store a GitHub token, password or key in chat/);
  assert.match(body, /never use the "Other" answer for one/);
  assert.match(body, /revoke it at GitHub/);

  // The interview runs through ask_question, within what that tool accepts (a question with one option is dropped).
  assert.match(body, /Every question goes through `ask_question`/);
  assert.match(body, /at least 2 options each/);
  assert.match(body, /"I approved it" \(recommended\) and "That did not work"/);

  // Nothing that lets it act happens without a clear yes, and the agent's account is not the person's own.
  assert.match(body, /Default to the safe choice/);
  assert.match(body, /Observe first/);
  assert.match(body, /dedicated account/);
  assert.match(body, /may not contain it, so the user could never ask it for anything/);
  assert.match(body, /Do not use computer use or browser automation/);

  // The order: look, configure, connect, verify, watch and mode, confirm, then switch on.
  const order = ["### 1. Look around", "### 2. Repository and people", "### 3. The agent's GitHub account", "### 4. Check access", "### 5. What to watch", "### 6. Confirm and turn on", "### 7. Wrap up"];
  const positions = order.map((heading) => body.indexOf(heading));
  assert.ok(positions.every((position) => position >= 0), `a step is missing: ${positions.join(", ")}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "the steps are in order");

  // The modes are described as the product behaves: observe still acts on direct mentions.
  assert.match(body, /an allowed account that mentions the agent still gets work done/);
});

test("the /superagent command loads the setup skill and forbids a token in chat", () => {
  const command = BUILTIN_COMMANDS.find((candidate) => candidate.name === "superagent");
  assert.ok(command, "/superagent ships built in");
  assert.equal(command.source, "built-in");
  assert.match(command.body, /`setup-superagent` skill/);
  assert.match(command.body, /`superagent_status` first/);
  assert.match(command.body, /never ask for or accept a GitHub token in chat/);
  assert.equal(expandCommand(command, "watch acme/app"), command.body.replace("$ARGUMENTS", "watch acme/app"));
});
