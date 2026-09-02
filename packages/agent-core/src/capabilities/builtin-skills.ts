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
    name: "create-automation",
    description:
      "Set up a scheduled automation (cron or manual) through the automation_* tools so it persists and arms the scheduler immediately. Use when the user asks to automate a task, schedule recurring research, or run a prompt every day/week at a given time.",
    content: `
# Create an Automation

Automations run an agent prompt on a schedule (cron) or on demand (manual), in a
workspace on this machine or in WSL. Create them with the automation_* tools —
they persist immediately and arm the scheduler; no restart, no file editing.

## 1. Gather what you need

Infer as much as possible from the conversation before asking:

- Goal: what should the agent do on every run? Draft the prompt from it.
- Schedule: map "daily at 8" to cron ~~~0 8 * * *~~~, "weekdays 9" to ~~~0 9 * * 1-5~~~, "hourly" to ~~~0 * * * *~~~. No schedule = manual.
- Workspace: where the run should happen. Default to the current workspace root unless the user says otherwise (create the folder if it does not exist yet).
- Model: leave unset to use the app default.

If wording for the prompt was given, keep it verbatim.

## 2. Create it

Call ~~~automation_create~~~ with name, description, prompt, cron, workspacePath.
Non-local targets (wsl) need distro and use the Openference provider.

## 3. Verify

- ~~~automation_list~~~ shows the automation with the expected schedule and enabled state.
- Offer one ~~~automation_run~~~ (id, waitSeconds ~ 120) to prove it works; report the final output.
- Runs also appear in Automations - Run History, with a desktop notification on finish.

## Notes

- A missed cron slot runs once on next app launch (catch-up), not once per missed slot.
- Scheduled runs need the app running and the computer awake.
- To change or remove later: automation_update / automation_delete.
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
    name: "review-bugbot",
    description:
      "Run the Bugbot subagent over the current changes and report its findings as a severity table. Use when the user asks for a bug review, runs /review-bugbot, or asks to review a PR or branch for bugs.",
    content: `
# Review with Bugbot

Launch exactly one \`bugbot\` subagent with the task tool. Do **not** compute the diff yourself — the subagent does that from the repository path, and duplicating it just burns context.

## 1. Resolve the target

Default target: the current workspace, current branch.

If the user named a PR link, PR number or branch ("review github.com/org/repo/pull/12", "review feat/x"), that branch must be checked out **before** you launch the subagent:

1. Resolve the link or number to the head branch (\`gh pr view <n> --json headRefName\` when \`gh\` is available).
2. If it is already the current branch, continue.
3. Otherwise try \`git switch <branch>\`.
4. If git refuses (local changes would be overwritten, conflicts, any other blocker), stop and explain the blocker, then ask whether to stash. Only stash after the user says yes, then retry the switch.

## 2. Launch it

~~~
task(subagent: "bugbot", background: false, prompt: """
Full Repository Path: <absolute repository path>
Diff: branch changes
Custom Instructions: <only when the user gave specific review focus>
""")
~~~

- \`Diff: branch changes\` (the default) reviews the branch against its merge-base with the base branch — committed, staged and unstaged changes together.
- \`Diff: uncommitted changes\` when the user asks for only the working tree / dirty / not-yet-committed changes.
- \`Base Branch: <name>\` only when you know the comparison base is not the repository default (for example this branch was cut from another feature branch).
- Run it in the background only when the user explicitly asks.

## 3. Handle failure once

- Called it wrong (missing \`Full Repository Path\`, missing \`Diff\`, wrong shape, wrong subagent name)? Fix the call and retry once immediately.
- The subagent reports it could not compute the diff (empty diff, missing metadata)? Retry once with \`Diff: natural language\`, drop \`Base Branch\`, and add a \`Change Description\` — one block per changed file, a \`<path> (added|modified|deleted|renamed)\` header followed by bullets of what changed, with line ranges where you know them:

  ~~~
  Change Description:
  src/auth/login.ts (modified):
  - validateSession (L40-58) now checks token expiry before the DB lookup
  - dropped the fallback that accepted empty tokens

  src/auth/mfa.ts (added):
  - verifyMfaCode() (L1-30) calls the TOTP service and rate-limits attempts
  ~~~

- Any other failure: retry once with the same prompt. If it fails the same way again, stop and tell the user in one line what blocked it. Do not keep retrying.

## 4. Report

- No diff: one sentence saying there was nothing to review.
- No findings: one line — "Bugbot found no bugs."
- Findings: print the subagent's table verbatim, sorted by severity, with exactly the columns Severity, Location (\`file:line\`), Finding. Add one line naming how many findings and whether any block merging.

Do not fix the findings or run the review again unless the user asks for that as the next step.
`,
  },
  {
    name: "review-security",
    description:
      "Run the Security Review subagent over the current changes and report its findings as a severity table. Use when the user asks for a security review, runs /review-security, or asks whether a change is safe to ship.",
    content: `
# Review with Security Review

Launch exactly one \`security-review\` subagent with the task tool. Do **not** compute the diff yourself — the subagent does that from the repository path.

## 1. Resolve the target

Default target: the current workspace, current branch. If the user named a PR link, PR number or branch, check that branch out first — same procedure as \`/review-bugbot\`: resolve to the head branch, \`git switch\`, and if git refuses, explain the blocker and ask before stashing.

## 2. Launch it

~~~
task(subagent: "security-review", background: false, prompt: """
Full Repository Path: <absolute repository path>
Diff: branch changes
Custom Instructions: <only when the user gave specific review focus>
""")
~~~

Same \`Diff\` options as Bugbot: \`branch changes\` by default, \`uncommitted changes\` when the user asks for only the working tree. Add \`Base Branch: <name>\` only when the comparison base is not the repository default. Background only when explicitly requested.

## 3. Handle failure once

- Wrong invocation: fix and retry once.
- Any other failure: retry once with the same prompt. If it fails again, stop and tell the user what blocked it in one line.

## 4. Report

- No diff: one sentence saying there was nothing to review.
- No findings: one line — "Security review found no issues."
- Findings: print the table verbatim, sorted by severity, columns Severity, Location (\`file:line\`), Finding. Then one line: how many findings, and whether any of them block shipping.

A security finding is only worth reporting with a concrete attack path. If the subagent hedged on one, keep its hedge in your summary rather than presenting it as confirmed.

Do not fix the findings unless the user asks.
`,
  },
  {
    name: "review",
    description:
      "Pick between the Bugbot and Security Review subagents, then run that review. Use when the user types /review without saying which kind.",
    disableModelInvocation: true,
    content: `
# Review

Ask which review to run with the \`ask_question\` tool — one single-select question with exactly two options:

- **Bugbot** — hunts for correctness, state and contract bugs in the diff (\`/review-bugbot\`).
- **Security Review** — audits the diff for exploitable vulnerabilities (\`/review-security\`).

If \`ask_question\` is unavailable, ask in plain text and wait for the answer.

Then run the matching review exactly once, following that skill's instructions:

- Bugbot → \`/review-bugbot\`
- Security Review → \`/review-security\`

Do not run both unless the user asks for both.
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

/* Configuration ------------------------------------------------------------- */
{
name: "add-provider",
description:
 "Add a model provider to Deyin config — credentials, base URL and model catalog — instead of manual entry in Settings. Use when the user asks to add a provider, add credentials or an API key, connect OpenAI/Anthropic/Groq/OpenRouter/Ollama or any custom endpoint, or wire models into the config.",
content: `
# Add a Provider

Wire a model provider into Deyin by writing its config directly: base URL, credentials and the model catalog — the same records the Settings → Models UI creates, so the provider appears there as a first-class citizen.

## 1. Collect the inputs

- Inputs: provider name, baseUrl, apiKey, apiFormat. Infer what you can; ask only for what is missing.
- Known providers — never ask for these URLs (id → baseUrl, all chat-completions unless noted):
  deepseek → https://api.deepseek.com · openai → https://api.openai.com/v1 · anthropic → https://api.anthropic.com (apiFormat "anthropic") · google → https://generativelanguage.googleapis.com/v1beta/openai · openrouter → https://openrouter.ai/api/v1 · groq → https://api.groq.com/openai/v1 · xai → https://api.x.ai/v1 · mistral → https://api.mistral.ai/v1 · ollama → http://localhost:11434/v1 (local, no key).
- Unknown provider: websearch its API base URL and confirm with the user before writing.
- Missing API key: ask for it — never invent one. Local providers (Ollama) need none.
- apiFormat: "chat-completions" (default), "responses" (OpenAI Responses API) or "anthropic". For "anthropic" also set authHeader: true unless it is a gateway that expects a Bearer header.

## 2. Locate the config

Providers live in agents.json in the desktop app data dir (file perms 0600):

- Windows: %APPDATA%\@deyin\desktop\agents.json
- macOS: ~/Library/Application Support/@deyin/desktop/agents.json
- Linux: ~/.config/@deyin/desktop/agents.json

Use ~/.deyin/agents.json (or $DEYIN_DATA_DIR) only for CLI-only setups or when the desktop dir does not exist. settings.json in the same dir holds defaultModel as "providerId::modelId". Read the file before editing; use file tools when the path is accessible, bash otherwise.

## 3. Edit agents.json

If the file is missing, start from {"disabledCaps": [], "providers": [], "providerSeedVersion": 3} — the app re-merges its built-in presets on next start. Derive the id like the app does: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") ("Together AI" → "together-ai"). If a provider with that id already exists, stop and tell the user.

New custom provider:

~~~json
{
  "id": "together-ai",
  "name": "Together AI",
  "kind": "custom",
  "enabled": true,
  "baseUrl": "https://api.together.xyz/v1",
  "apiFormat": "chat-completions",
  "connectionModes": ["API key"],
  "activeMode": "API key",
  "models": [],
  "disabledModels": [],
  "keyCipher": "plain:THE-REAL-KEY"
}
~~~

Known providers ship as disabled presets (matching id, preset: true): set enabled: true and add keyCipher, leaving their other fields alone. The key goes in as "plain:<key>" — the app's own fallback when OS keychain encryption is unavailable; it reads plain: keys fine. Never echo the full key back. Never touch records with "kind": "primary" (the Openference entry), and keep JSON valid — preserve every other record.

## 4. Search the model catalog

Probe the OpenAI-compatible catalog with the real key:

~~~bash
BASE_URL='https://api.groq.com/openai/v1'
KEY='the-key' # never paste real keys into logs or the reply
curl -sS -H "Authorization: Bearer $KEY" "$BASE_URL/models"
~~~

An OpenAI-shaped reply is {"data": [{"id": "..."}]}. Map each entry to {"id": m, "name": m} in provider.models (skip ids listed in disabledModels); copy context_length into contextLength when present. Leave models: [] when the probe fails, needs a different path, or returns a non-OpenAI shape, and say the model list will fill in from Settings → Models. For apiFormat "anthropic", try GET {baseUrl}/v1/models with x-api-key and anthropic-version headers before giving up.

## 5. Restart and verify

The app loads agents.json only at startup, so ask the user to restart Deyin (or restart it for them). Then verify: re-read agents.json and confirm the record is present and valid; in Settings → Models the provider shows as connected with its models listed. Report provider name, id and model count, plus anything skipped.

## Example

"add my Groq key gsk_..." → groq is a preset: set enabled: true plus keyCipher, probe https://api.groq.com/openai/v1/models, write the model ids into models, ask for a restart, confirm the provider shows connected.
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
  {
    name: "generate-image",
    description:
      "Create or edit pictures with an image model and embed them in the reply. Use when the user asks for an image, illustration, icon, logo, mockup, concept art, texture, a picture of anything, or a change to a picture already in the thread.",
    content: `
# Generate an Image

Deyin reaches image models two ways, and the right one depends on the model the run is on:

| Situation | What happens |
| --- | --- |
| The run's model draws by itself (Gemini flash-image / nano-banana, an image tool on the Responses API) | Just answer with the picture — it is captured and embedded for you. Nothing to call. |
| The run's model is text-only | Call \`generate_image\`; it routes to a text-to-image model (FLUX, SDXL, DALL·E, gpt-image) or to a chat model that draws. |
| The user picked a text-to-image model in the composer | Their message goes straight to the images endpoint — you are not in the loop. |

If \`generate_image\` is not in your tool list, the signed-in plan has no image model at all. Say so and offer an SVG, an HTML mockup or a chart instead — do not pretend the picture is coming.

## 1. Decide whether to generate

Generate when the user asks to *see* something: illustration, icon, logo idea, character, texture, poster, UI mockup, concept art, photo-style scene. Do not generate for diagrams of code or data that a chart or ASCII sketch communicates better — use \`visualize_write\` for charts and HTML, \`write\` for SVG a developer will edit.

## 2. Write the prompt

A text-to-image model never sees the conversation, so the prompt must stand alone. Fold in what the user said, plus the details they implied:

- Subject and action: "a red fox curled asleep"
- Setting: "on a mossy log in a foggy pine forest"
- Style: "watercolor illustration", "isometric 3D render", "35mm photo"
- Composition and light: "close-up, shallow depth of field, warm rim light"
- For icons/logos: "flat vector icon, centered, solid background, no text"

Keep it one dense paragraph. Image models are weak at text inside pictures — if the user needs words in the image, say so and offer to render the text as a caption or in HTML instead.

Use \`negative_prompt\` for what must not appear ("no watermark, no extra fingers, no text").

## 3. Call the tool

~~~
generate_image(
  prompt: "flat vector icon of a paper plane, single accent color, centered on a plain background, crisp edges, no text",
  size: "1024x1024",
  alt: "Paper-plane app icon"
)
~~~

- \`model\` — omit it and the best available image model is used. Name one when the user asks for a specific model, or when they want speed (a "lightning"/"turbo" variant) over fidelity.
- \`size\` — "1024x1024" square by default; "1152x896" landscape, "896x1152" portrait. Match the use ("wallpaper" → landscape, "app icon" → square).
- \`n\` — ask for 2-3 only when the user wants options; each image costs a generation.

## 4. Edit an existing picture

To change a picture instead of drawing a new one, pass \`input_images\`:

~~~
generate_image(
  prompt: "same composition at night: dark blue sky, lit windows, warm street lamps",
  input_images: ["img-abc123.png"]
)
~~~

- A picture the user attached to their message, or one you generated earlier, is stored with the thread — use the file name the message or the previous tool result gave you.
- A picture in the repo is referenced by its workspace path ("assets/hero.png").
- Describe the change *and* what must stay the same; an edit prompt that only names the change often re-draws the whole scene.

## 5. Put it in the project when it belongs there

For a picture the repo should keep — a README image, an icon, a test fixture — add \`save_to\`:

~~~
generate_image(prompt: "...", save_to: "assets/hero.png")
~~~

The file is written to the workspace as well as the thread, so \`read\`, \`bash\` and a commit can all see it. Without \`save_to\` the picture lives only in the chat.

## 6. Embed the result in your reply

The tool returns one or more directives. Copy each one onto its own line in your reply — unembedded, the picture never appears:

~~~
Here is the icon:

::deyin-inline-image{file="img-abc123.png" alt="Paper-plane app icon"}
~~~

Say one line about what you made, then let the picture speak. Do not describe the image back to the user in detail — they can see it.

## 7. Iterate

When the user asks for changes, edit or regenerate rather than apologizing: carry over what worked, change only what they objected to, and say what you changed ("same composition, colder palette"). Keep the old directive out of the new reply so the thread shows the current version.

## Failure modes

- "No image model is available" — the plan has none enabled. Tell the user to pick one under Settings → Models, and offer an SVG or HTML alternative meanwhile.
- "cannot edit images on this provider" — that model has no edit endpoint. Retry the edit naming a chat model that draws, or regenerate from a fuller prompt.
- "returned text, not an image" — the model answered in words; usually the prompt read like a question. Rewrite it as a description of the picture.
- Other generation errors quote the provider's message; a rejected size is the usual cause — retry once at "1024x1024" before reporting failure.

## Verify

The reply contains one directive per image, each on its own line, the file names match what the tool returned, and anything the user wanted kept in the repo was written with \`save_to\`.
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
  let entries: string[];
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
    let current: string | null;
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
