import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILTIN_SKILLS, materializeBuiltinSkills } from "../src/capabilities/builtin-skills.js";
import { expandCommand, discoverCommands, matchCommand } from "../src/capabilities/commands.js";
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
    const servers = await loadMcpServers(ws, {}, home);
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
