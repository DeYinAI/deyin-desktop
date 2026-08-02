import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skills that ship with Deyin. Modeled on the proven structure of the best
 * public agent skill libraries but written for Deyin: our directories
 * (`.deyin/...`), our tool names (read/write/edit/grep/glob/bash/websearch/
 * todo_write/codebase_search/browser_*), our subagents and hooks schema.
 *
 * They are materialized to real SKILL.md files (see materializeBuiltinSkills)
 * so the agent reads them with the read tool like any other skill, users can
 * inspect them, and a workspace or user skill with the same name overrides
 * the built-in via normal registry precedence.
 */

export interface BuiltinSkill {
  name: string;
  description: string;
  /** Manual-only skills are invoked with /name and never auto-selected. */
  disableModelInvocation?: boolean;
  /** Markdown body (without frontmatter). */
  content: string;
}

function fm(skill: BuiltinSkill): string {
  const lines = [`---`, `name: ${skill.name}`, `description: ${JSON.stringify(skill.description)}`];
  if (skill.disableModelInvocation) lines.push("disable-model-invocation: true");
  lines.push("---", "");
  return lines.join("\n");
}

/** Full SKILL.md text for one built-in. */
export function renderBuiltinSkill(skill: BuiltinSkill): string {
  return `${fm(skill)}${skill.content.trim()}\n`;
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  /* Authoring ------------------------------------------------------------- */
  {
    name: "create-skill",
    description:
      "Author a new agent skill (SKILL.md). Use when the user asks to create a skill, save a workflow as a skill, or asks how skills work.",
    content: `
# Create a Skill

A skill is a folder with a SKILL.md that teaches the agent a repeatable workflow: a review checklist, a deploy runbook, a commit-message format, a domain recipe. The agent sees every skill's name and description, and reads the full file only when the skill is used — so the description decides discovery, and the body carries the knowledge.

## 1. Gather what you need

Infer as much as possible from the conversation before asking:

- Purpose: what task should this skill make repeatable?
- Scope: personal (~/.deyin/skills/) or this project (.deyin/skills/, shared via version control)?
- Triggers: which user requests should activate it?
- Knowledge: what does the agent need that it would not already know (commands, conventions, gotchas)?
- Output: any required format or template?

If the user gave exact wording for instructions, keep it verbatim — do not paraphrase their copy.

## 2. Write the file

Location: \`<scope>/skills/<skill-name>/SKILL.md\`, kebab-case name matching the folder.

~~~markdown
---
name: skill-name
description: What it does and when to use it, in third person, with trigger terms.
---

# Skill Name

## Steps
1. ...
2. ...

## Example
...
~~~

Optional frontmatter: \`disable-model-invocation: true\` for skills that should only run when the user types /skill-name (destructive or highly specific workflows).

## 3. Make the description count

The description is injected into the system prompt; the body is not. Include WHAT the skill does and WHEN to use it, in third person, with concrete trigger words.

- Good: "Generates conventional commit messages from staged changes. Use when committing or when the user mentions commit messages."
- Bad: "Helps with commits."

## 4. Body guidelines

- Step-by-step instructions an agent can follow without guessing; name the exact tools and commands.
- Concrete examples beat abstract advice; include one worked example.
- Keep it under ~150 lines. Split reference material into sibling files and mention them.
- End with a short verification step: how does the agent know it worked?

## 5. Verify

After writing, confirm the file exists at the expected path and summarize: name, where it lives, when it triggers, and that it is available as /skill-name and in Settings -> Skills.
`,
  },
  {
    name: "create-rule",
    description:
      "Create project rules in .deyin/rules that steer every agent session. Use when the user wants coding standards, conventions, or persistent instructions applied automatically.",
    content: `
# Create a Rule

Rules are markdown files in \`.deyin/rules/\` loaded into the system prompt of every agent session in this workspace. Use them for standing instructions: coding standards, architecture constraints, tone, review requirements.

## 1. Decide what the rule enforces

- One concern per rule file; split unrelated standards into separate files.
- If the user described the behavior in chat, distill it — do not ask again for what they already said.

## 2. Write the file

\`.deyin/rules/<topic>.md\`, plain markdown, no frontmatter needed:

~~~markdown
# Error handling

- Never swallow exceptions; log with context and rethrow a typed error.
- User-facing messages never contain stack traces.

Example:
...one short good/bad pair...
~~~

## 3. Keep rules effective

- Under 50 lines each; actionable, like good internal docs.
- Concrete good/bad examples are worth more than prose.
- Rules apply to every session in the workspace — do not put task-specific instructions here; use a skill for workflows.

## 4. Verify

List \`.deyin/rules/\` to confirm the file landed, and tell the user the rule now applies to new agent sessions in this workspace.
`,
  },
  {
    name: "create-hook",
    description:
      "Create or edit lifecycle hooks in .deyin/hooks.json. Use when the user wants to run scripts around agent events, gate shell commands, audit tool use, or automate checks.",
    content: `
# Create a Hook

Hooks run custom commands around agent lifecycle events. They receive the event payload as JSON on stdin and answer over stdout/exit code: exit 0 = allow (stdout may carry JSON), exit 2 = block the action, anything else = fail open unless \`failClosed\` is set.

## 1. Gather requirements

- Scope: project (\`.deyin/hooks.json\`, checked in) or user (\`~/.deyin/hooks.json\`)?
- Event: pick the narrowest one that matches the goal:
  - \`beforeShellExecution\` / \`afterShellExecution\` — gate or audit shell commands (matcher tests the command text)
  - \`preToolUse\` / \`postToolUse\` — any tool call (matcher tests the tool name)
  - \`sessionStart\` — inject context or set up state (stdout \`additional_context\` is added to the system prompt)
  - \`stop\` — run when the agent finishes
- Behavior: audit only, block, or inject context?
- Safety: fail open (default) or \`failClosed: true\` when the hook itself crashes?

## 2. Write hooks.json

~~~json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [
      { "command": ".deyin/hooks/guard-network.sh", "matcher": "curl|wget|nc ", "timeout": 30 }
    ]
  }
}
~~~

Fields per hook: \`command\` (required), \`matcher\` (JavaScript-style regex — use \\s, not POSIX classes), \`timeout\` seconds (default 30), \`failClosed\`.

Project hook commands run from the project root (use \`.deyin/hooks/x.sh\` paths); user hooks run from your home directory.

## 3. Write the script

~~~bash
#!/usr/bin/env bash
payload=$(cat)            # event JSON on stdin
cmd=$(printf '%s' "$payload" | grep -o '"command":"[^"]*"' | head -1)
case "$cmd" in
  *"rm -rf /"*) echo '{"agent_message":"Blocked: destructive command."}'; exit 2 ;;
esac
exit 0
~~~

Before finishing, verify the script is executable (\`chmod +x\`) and every binary it calls exists on PATH — do not assume tools like jq are installed.

## 4. Test and verify

Echo a sample payload into the script and check the exit code for both the allow and block paths. Start without a matcher (or a trivially simple one), confirm the hook fires, then tighten. Confirm the hook appears in Settings -> Hooks.
`,
  },
  {
    name: "create-subagent",
    description:
      "Create a custom subagent definition in .deyin/agents. Use when the user wants a specialized helper agent (reviewer, debugger, domain expert) the main agent can delegate to.",
    content: `
# Create a Subagent

Subagents are specialized helpers the main agent delegates to through the task tool. Each runs in a clean context with its own system prompt, so intermediate noise stays out of the main conversation.

## 1. Decide scope and role

- Project (\`.deyin/agents/\`, shared with the team) or user (\`~/.deyin/agents/\`)?
- One focused job per subagent. "Reviews database migrations" beats "helps with backend".

## 2. Write the file

\`<scope>/agents/<name>.md\` — frontmatter + the subagent's system prompt as the body:

~~~markdown
---
name: migration-reviewer
description: Reviews database migrations for destructive operations, lock risk and rollback safety. Use proactively whenever a migration file is added or changed.
readonly: true
---

You are a database migration reviewer. When invoked:
1. Read the migration files named in the prompt.
2. Check for destructive operations, long-lock DDL, missing indexes for new queries, and rollback safety.
3. Report findings ordered by severity with file:line references and a concrete fix for each.
Never modify files.
~~~

Frontmatter fields:

- \`name\` (kebab-case) and \`description\` (required) — the description drives delegation; include "use proactively" plus trigger terms when the main agent should reach for it on its own.
- \`model\` — pin a model id, or omit to inherit the caller's.
- \`effort\` — reasoning effort for models that support it: \`low\`, \`medium\`, or \`high\`. Omit to inherit the default.
- \`max_steps\` — cap the subagent's tool-call steps (e.g. \`max_steps: 15\`); omit for the global default.
- \`readonly: true\` — denies write/edit and gates bash behind approval; right for reviewers and explorers.
- \`is_background: true\` — the task tool returns immediately and the result surfaces when done.
- \`tools: [read, grep, glob, ls]\` — optional allowlist restricting the subagent to these tools (permission rules still apply).

## 3. Write a prompt that stands alone

Subagents start with a clean context: the body must say what to do when invoked, the process to follow, and the exact report format. Structure it as a task contract — Context, Request, Output format, Boundaries, Pause policy. Remind read-only agents to never modify anything.

## 4. Verify

Confirm the file exists, then test with: "Use the <name> subagent to <task>". It should also appear in Settings -> Subagents.
`,
  },

  /* Engineering workflows -------------------------------------------------- */
  {
    name: "review-code",
    description:
      "Structured review of a diff or recent changes: correctness, security, edge cases, style. Use when the user asks for a code review or before finalizing significant changes.",
    content: `
# Review Code

## 1. Establish the diff

- Working tree: \`git status\` + \`git diff\` (and \`git diff --staged\`).
- Branch: \`git log --oneline <base>..HEAD\` + \`git diff <base>...HEAD\`.
- If the target is ambiguous, review uncommitted changes first.

For large diffs, delegate to the built-in \`reviewer\` subagent with the task tool — give it the base ref and the concerns to focus on — and merge its findings into your report.

## 2. Read for real defects, in priority order

1. Correctness: logic errors, inverted conditions, off-by-one, broken error paths, race conditions, state mutations.
2. Security: injection, path traversal, secrets in code or logs, missing validation at trust boundaries, unsafe deserialization.
3. Edge cases: empty/null inputs, unicode, timezone/DST, concurrent access, failure mid-operation.
4. Regressions: does the change break callers? grep for other usages of changed signatures and behavior.
5. Style/consistency: only flag drift from this codebase's own conventions — read neighboring files before claiming a violation.

Read the surrounding code, not just the hunks; most real bugs live at the boundary between the change and what it touches.

## 3. Report

Order findings by severity, each with file:line, the problem, why it matters, and a concrete fix:

~~~
CRITICAL src/auth.ts:42 — refresh token is logged on failure. Leaks credentials to log storage. Redact before logging.
WARN     src/sync.ts:118 — retry loop has no backoff cap; a persistent 500 spins forever. Cap attempts or add jittered backoff.
NIT      src/api.ts:20 — this file uses camelCase for constants; the rest of the module uses SCREAMING_SNAKE.
~~~

End with a one-line verdict: safe to merge, needs fixes, or blocked — and say which findings block.
`,
  },
  {
    name: "generate-tests",
    description:
      "Write tests for a file, function or change set using the project's own test framework, then run them. Use when the user asks for tests or coverage of recent changes.",
    content: `
# Generate Tests

## 1. Detect how this project tests

- Find the runner: check package.json scripts (test), pyproject/pytest.ini, go.mod, Cargo.toml, Makefile.
- Find the conventions: glob for existing tests (\`**/*.test.*\`, \`**/*_test.*\`, \`tests/\`) and read one or two near the code under test — copy their import style, naming, setup/teardown and assertion patterns exactly.
- If there is no test setup at all, propose the lightest standard choice for the stack before adding dependencies.

## 2. Decide what to test

Read the code under test first. Cover, in order of value:

1. The core happy path with realistic inputs.
2. Edge cases the code visibly handles (empty, null, boundaries, unicode, zero/negative).
3. Error paths: invalid input, dependency failure, timeouts.
4. Any bug just fixed — write the regression test that would have caught it.

Test observable behavior, not implementation details. Prefer real objects over mocks; mock only true externals (network, clock, filesystem when slow).

## 3. Write and run

- Place tests where the project convention puts them, mirroring source structure.
- One behavior per test, named for the behavior ("rejects expired tokens"), independent of test order.
- Run the exact suite (\`npm test\`, \`pytest <file>\`, \`go test ./...\`) and iterate until green.
- If a test fails because the CODE is wrong, say so — do not bend the test to pass a bug.

## 4. Report

List the behaviors now covered, the command to run them, and anything intentionally left uncovered.
`,
  },
  {
    name: "refactor",
    description:
      "Apply a named refactoring across the workspace in small verifiable steps. Use when the user asks to rename, extract, restructure or modernize code without changing behavior.",
    content: `
# Refactor

Behavior must not change. Structure does.

## 1. Map the blast radius

- Find every usage before touching anything: grep for the symbol (and its string/dynamic forms), glob for related files, check exports, re-exports, docs, configs and tests.
- Read enough of each call site to know how it will be affected.
- Note the safety net: which build/lint/test commands prove behavior is intact? Run them once BEFORE changing anything to know the baseline.

## 2. Plan small steps

Track the steps with todo_write. Each step must leave the codebase compiling and tests passing:

1. Introduce the new shape (new name/module/signature) alongside the old where possible.
2. Migrate callers in coherent batches (per package or per layer).
3. Remove the old shape once nothing references it — verify with grep, not memory.

Do not mix behavior changes or drive-by cleanups into the refactor; note them for later instead.

## 3. Execute and verify each step

- Prefer edit over rewrite; keep diffs reviewable.
- After each batch: typecheck/build + the focused tests, then the full suite at the end.
- If a step fans out wider than expected, stop and reassess rather than forcing it.

## 4. Report

Summarize what moved where, the verification commands that passed, and any call sites deliberately left (with reasons).
`,
  },
  {
    name: "debug-issue",
    description:
      "Systematic debugging: reproduce, isolate, fix the root cause, verify. Use when something fails, errors appear, tests break, or behavior is unexpected.",
    content: `
# Debug an Issue

Fix causes, not symptoms. Do not change code before the failure is understood.

## 1. Reproduce first

- Get the exact failure: full error text, stack trace, failing command or test. Run it yourself and capture the output.
- If it cannot be reproduced, gather evidence before theorizing: logs, recent commits (\`git log --oneline -15\`), environment differences.

## 2. Isolate

- Read the code at the failure point and follow the data backwards; grep for the error message to find its true origin.
- Form one hypothesis at a time and test it cheaply: a focused test run, a temporary log line, a narrowed input.
- \`git diff\` / recent commits often point at the trigger — what changed last?
- Keep a note of ruled-out hypotheses so you do not loop.

## 3. Fix the root cause

- Make the smallest change that corrects the underlying defect, not one that hides the symptom (no blanket try/catch, no sleep-based fixes, no disabling the failing test).
- If the real fix is genuinely large, say so and propose it before patching around it.

## 4. Verify and harden

- Re-run the original reproduction — it must pass now.
- Run the surrounding test suite to catch collateral damage.
- Remove temporary instrumentation.
- Add the regression test that would have caught this, when the project has a test setup.

## 5. Report

State the root cause in one sentence, the evidence, the fix, and how it was verified.
`,
  },
  {
    name: "verify-in-browser",
    description:
      "Verify UI changes end to end in the built-in browser: navigate, inspect, interact, screenshot, check console/network. Use after frontend changes or when the user asks to check a page.",
    content: `
# Verify in the Browser

Use the built-in browser tools to prove a UI change actually works. Never claim a frontend change works without doing this when browser tools are available.

## 1. Get the app running

- Reuse a dev server if one is already running (check terminals/ports); otherwise start it with bash in the background and wait for the ready line.
- Note the URL (default to the port the framework prints).

## 2. Look, then interact

1. \`browser_navigate\` to the page under test.
2. \`browser_snapshot\` — structured view: title, URL, interactive elements with CSS selectors. Use it to find what to click; do not guess selectors.
3. Interact like a user: \`browser_click\` (selector), \`browser_type\` (text, optional selector to focus), \`browser_press\` (enter/tab/escape), \`browser_scroll\`.
4. \`browser_screenshot\` at meaningful states — after load and after the key interaction — and read the saved file to inspect it.

## 3. Check the invisible failures

- \`browser_console\` — errors and warnings that do not show in the UI.
- \`browser_network\` — failed requests, wrong status codes.
- Ask for only the lines you need (they are tailed from log files).

## 4. Judge against the requirement

Compare what you saw with what the change was supposed to do: element present, state updates after interaction, no new console errors, requests succeed. If something fails, fix the code and re-verify — screenshot evidence, not hope.

## 5. Report

State what was verified (URL, interactions), attach the screenshot paths, and list any console/network issues found — including pre-existing ones you did not cause.
`,
  },
  {
    name: "onboard",
    description:
      "Explore and explain an unfamiliar codebase: structure, entry points, stack, conventions, how to run it. Use when the user opens a new project or asks how the codebase works.",
    content: `
# Onboard to a Codebase

Produce an accurate working map of this repository — from evidence, not guesses.

## 1. Survey the terrain

- \`ls\` the root; read the README and any CONTRIBUTING/docs index.
- Identify the stack from manifests: package.json (and workspaces), pyproject.toml, go.mod, Cargo.toml, docker-compose, CI configs.
- Note the package manager, build system and test runner actually configured — scripts sections tell the truth.

## 2. Find the spine

- Entry points: main/index files, server bootstrap, app roots; follow imports one or two hops.
- Use codebase_search for meaning-level questions ("where is authentication handled?", "how are settings persisted?") and grep for exact symbols.
- Map the 3-6 load-bearing directories and what owns what. Skim one representative file per area rather than reading everything.

## 3. Capture conventions

- Naming, module layout, error handling and test patterns from real files.
- Existing agent instructions: AGENTS.md, .deyin/rules/ — quote them, they outrank inference.

## 4. Report

Deliver a compact brief:

- What this is (one paragraph), the stack, and how to install / run / test (exact commands).
- Architecture: the main directories and how data flows between them.
- Conventions that future changes must follow.
- Sharp edges noticed (generated files, pinned versions, unusual build steps).

Keep it under a page; link paths rather than pasting long code.
`,
  },

  /* Git / process ---------------------------------------------------------- */
  {
    name: "split-to-prs",
    description:
      "Split accumulated changes into small reviewable branches/PRs. Use when the user asks to split a branch, working tree, or pile of changes into separate PRs.",
    disableModelInvocation: true,
    content: `
# Split to PRs

Turn one pile of work into a few small, reviewable PRs — without ever losing work.

## Hard rules

- No branches, commits, pushes or PRs until the user approves the split plan.
- Nothing destructive: no \`reset --hard\`, \`clean\`, force-push, branch deletion or history rewriting without explicit approval.
- Snapshot before moving anything (step 3).
- Stage only named files or hunks — never \`git add .\` / \`git add -A\`.

## 1. See what exists

\`git status\`, \`git diff <default-branch>...HEAD\`, plus uncommitted changes. Summarize the real slices in the work; use the conversation to recover intent.

## 2. Propose the split

- Group by concern and reviewer boundary; keep tightly coupled changes together.
- Default to independent PRs off the default branch; stack only when a dependency is real, foundations first.
- Present as a short list of PR titles (one-line scope note only where a title is unclear) and ask for approval.

## 3. Snapshot, then execute

Save a recoverable snapshot without touching the working tree:

~~~bash
SHA=$(git stash create "pre-split")
[ -n "$SHA" ] && git update-ref "refs/backup/pre-split-$(date +%s)" "$SHA"
~~~

For each approved slice: branch from the right base, stage exactly the planned files/hunks (\`git add <paths>\` or \`git add -p\`), commit with a message explaining why, push, and open the PR (\`gh pr create\`) when gh is available.

## 4. Report

PR titles and URLs, plus whatever remains on the original branch/working tree. Leave the backup ref alone unless asked to clean it up.
`,
  },
  {
    name: "env-setup",
    description:
      "Get a fresh checkout running: detect the toolchain, install dependencies, make build and tests pass. Use when setup fails or the user asks to set up the dev environment.",
    content: `
# Environment Setup

Goal: from fresh checkout to green build and tests, with every step reproducible.

## 1. Detect before installing

- Toolchain and versions: manifests (package.json engines, .nvmrc, pyproject, go.mod, rust-toolchain), lockfiles (pnpm-lock -> pnpm, yarn.lock -> yarn, package-lock -> npm, uv.lock/poetry.lock accordingly). Use the manager the lockfile implies — never a different one.
- Read the README/CONTRIBUTING setup section first; projects often have one blessed path (a make target, a setup script).
- Check the local reality: \`node --version\`, \`python3 --version\`, etc. against what the project wants.

## 2. Install in the right order

1. System-level prerequisites only if actually missing.
2. Project dependencies with the detected manager (\`pnpm install\`, \`npm ci\`, \`uv sync\`, \`go mod download\`...).
3. Generated state the project expects: env files from .env.example (never invent secrets — leave placeholders and tell the user), codegen, database migrations.

Keep every step non-interactive and idempotent; if a step must be repeated, it should converge, not append.

## 3. Prove it works

- Build: the project's build command.
- Tests: the project's test command; a targeted subset first when the suite is huge.
- Dev server: start it, confirm the ready line, then stop it (or leave it running if the user wants to work).

Fix failures at the cause (wrong version, missing prerequisite, stale cache) rather than piling on flags.

## 4. Report

List what was installed/configured, the exact commands for build/test/dev from now on, and anything that still needs a human (real secrets, accounts, licenses).
`,
  },
  {
    name: "loop",
    description: "Re-run a prompt or check on an interval within the current run. Invoke as /loop <interval> <prompt>.",
    disableModelInvocation: true,
    content: `
# Loop

Repeat a task on a schedule inside the current agent run, e.g. \`/loop 30s check whether the deploy finished\`.

## Parse

\`/loop [interval] <prompt>\` — leading interval like \`30s\`, \`5m\`; or trailing "every 5 minutes". Without an interval, choose a sensible one from the task (fast checks 15-60s, slow pipelines 2-5m). With no prompt, reply with usage.

## Constraints — read first

The loop lives inside one agent run, which has a step budget (~40 tool calls) and a per-command timeout (600s max). So:

- Cap iterations up front: iterations ≈ min(10, remaining budget / 2). Say the cap.
- For intervals over ~8 minutes, or watching that should outlive this run, say the run cannot sleep that long and offer alternatives: re-invoking /loop later, or a hooks/CI-based check.

## Run

1. Run the prompt once immediately and report the result.
2. Then per iteration: \`bash sleep <seconds>\` (combine into the check when possible: \`sleep 30 && <check command>\`), run the check, and report only what changed since the last iteration.
3. Stop early when a stop condition is met — the thing succeeded, failed definitively, or further checks are pointless — and say why.

## Stop conditions

Always define one before starting: "until the deploy status is success or failed", "until tests pass", "at most 10 iterations". On stop, summarize all iterations in two or three lines.
`,
  },
];

/**
 * Write the built-in skills into `dir` (one folder per skill), rewriting a
 * file only when its content changed, and removing folders of built-ins that
 * no longer exist. Returns the number of files written.
 */
export function materializeBuiltinSkills(dir: string): number {
  mkdirSync(dir, { recursive: true });
  const expected = new Set(BUILTIN_SKILLS.map((s) => s.name));

  // Drop stale skills from older versions so they stop being discovered.
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!expected.has(entry)) {
      rmSync(join(dir, entry), { recursive: true, force: true });
    }
  }

  let written = 0;
  for (const skill of BUILTIN_SKILLS) {
    const skillDir = join(dir, skill.name);
    const file = join(skillDir, "SKILL.md");
    const next = renderBuiltinSkill(skill);
    let current: string | null = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = null;
    }
    if (current !== next) {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(file, next, "utf8");
      written += 1;
    }
  }
  return written;
}
