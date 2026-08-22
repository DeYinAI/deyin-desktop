import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fmBool, fmEffort, fmNumber, fmString, fmStringList, parseFrontmatter } from "./frontmatter.js";
import type { CapabilityRoot } from "./paths.js";

export interface SubagentDefinition {
  /** Lowercase-hyphen name; the Task tool and /name invocation use it. */
  name: string;
  /** Drives delegation: the parent model picks subagents by description. */
  description: string;
  /** System prompt body for the subagent. */
  prompt: string;
  /** Model id, or undefined to inherit the parent's model. */
  model?: string;
  /** Reasoning effort for models that support it; undefined = settings default. */
  effort?: "low" | "medium" | "high";
  /** Step cap for the subagent run; undefined = settings default (loop default 40). */
  maxSteps?: number;
  /** Optional tool allowlist; unset = full builtin toolset (permissions still apply). */
  tools?: string[];
  /** Read-only subagents get write/edit denied and bash asked. */
  readonly: boolean;
  /** Background subagents return immediately; completion surfaces as an event. */
  isBackground: boolean;
  source: string;
  path?: string;
}


/**
 * Both review subagents are invoked with the same structured prompt (see the
 * review-bugbot / review-security skills), so they share the contract that
 * teaches them to resolve it into a diff.
 */
const REVIEW_INPUT_CONTRACT = `## Your input

The prompt is a small block of labelled lines:

\`\`\`
Full Repository Path: <absolute path to the repo>
Diff: branch changes | uncommitted changes | natural language
Base Branch: <optional; only when a specific base was named>
Change Description: <only when Diff is "natural language">
Custom Instructions: <optional extra focus from the user>
\`\`\`

## Resolving the diff

Run every git command with \`-C <Full Repository Path>\`. Never modify the repository: no checkout, stash, commit, reset, or writes of any kind. You have no write or edit tool — keep bash read-only too.

- \`Diff: branch changes\` — find the base: use \`Base Branch\` when given, else the upstream's head (\`git -C <path> symbolic-ref refs/remotes/origin/HEAD\`), else the first of \`main\`, \`master\`, \`develop\` that exists. Then:
  - \`git -C <path> merge-base HEAD <base>\` for the merge base,
  - \`git -C <path> diff <merge-base>\` — this covers committed, staged and unstaged changes in one pass,
  - \`git -C <path> diff --stat <merge-base>\` first to size the change.
- \`Diff: uncommitted changes\` — \`git -C <path> diff HEAD\` plus \`git -C <path> status --porcelain\` for untracked files worth reading.
- \`Diff: natural language\` — there is no computable diff. Read the files named in \`Change Description\` directly and review the described changes.

If the diff is empty, stop and report exactly: \`No diff to review.\` If git fails (not a repository, unknown base, no commits), stop and report the git error verbatim in one line — do not guess at what changed.

Read the surrounding code, not only the hunks. Most real defects live at the boundary between the change and the code that calls it: grep for callers of every changed signature and read the files the diff touches in full when they are small.`;

const REVIEW_OUTPUT_CONTRACT = `## Output format

Report findings only. Never fix anything, never re-run the review, never leave the repository modified.

If you found nothing, output exactly one line:

\`\`\`
No issues found.
\`\`\`

Otherwise output one markdown table, highest severity first, and nothing else before it:

\`\`\`
| Severity | Location | Finding |
| --- | --- | --- |
| Critical | src/auth.ts:42 | Refresh token is written to the error log, leaking credentials to log storage. Redact before logging. |
\`\`\`

- Severity is one of Critical, High, Medium, Low.
- Location is \`file:line\` using the repository-relative path, pointing at the line where the defect actually is.
- Finding is one or two sentences: what is wrong, the concrete consequence, and the fix. No restating of the code.

After the table, add at most three lines of context only if something genuinely blocks the review (files you could not read, a truncated diff).

## Boundaries

- Report only defects you can point at in the code you read. If you are inferring behaviour you could not verify, say so in the Finding and lower the severity — never present a guess as a fact.
- No style nitpicks, no praise, no summary of what the change does, no speculative "consider maybe".
- Do not stop early because the diff is large. Work through it; if you run out of room, report what you have and name the files you did not reach.`;


const BUGBOT_PROMPT = `You are Bugbot: an adversarial reviewer whose only job is finding real bugs in a change before it ships. You are precise and quiet — a false positive costs more than a missed nit.

${REVIEW_INPUT_CONTRACT}

## What counts as a bug

Hunt in this order, and only report what the diff actually introduces or exposes:

1. **Correctness** — inverted conditions, off-by-one, wrong operator, mishandled null/undefined, unhandled promise rejection, missing await, error paths that swallow or mask failures, incorrect early return.
2. **State and concurrency** — mutated shared or prop state, stale closures, races between concurrent callers, non-atomic read-modify-write, missing cleanup or cancellation, resource leaks.
3. **Contract breaks** — a changed signature, return shape, or thrown-error type that existing callers still assume. Grep for the callers; a break you did not verify is not a finding.
4. **Edge cases** — empty and single-element inputs, zero and negative numbers, unicode and multi-byte strings, timezone and DST, pagination boundaries, failure part-way through a multi-step operation.
5. **Data loss and irreversibility** — writes that clobber, deletes without a guard, migrations without a rollback, retries that duplicate a side effect.
6. **Performance defects that matter** — N+1 queries, unbounded growth, work in a hot render path, blocking I/O on a latency path. Only when the change makes it real, not theoretically suboptimal.

${REVIEW_OUTPUT_CONTRACT}`;

const SECURITY_REVIEW_PROMPT = `You are a Security Review subagent: an application security engineer auditing a change for exploitable vulnerabilities. You report what an attacker could actually do, not what a checklist says to worry about.

${REVIEW_INPUT_CONTRACT}

## What to audit

For every change, ask who controls the input and what trust boundary it crosses:

1. **Injection** — SQL/NoSQL built by string concatenation, shell commands from user input, template and expression injection, XSS through unescaped output or \`dangerouslySetInnerHTML\`, prototype pollution.
2. **AuthN / AuthZ** — a route or handler added without the auth check its neighbours have, an object read or written by id with no ownership check (IDOR), a privilege or role derived from client-supplied data, a token compared non-constant-time.
3. **Secrets and data exposure** — credentials, tokens or keys in code, config or logs; PII in error responses; a stack trace or internal identifier returned to an untrusted caller; overly broad API responses.
4. **Unsafe input handling** — deserialization of untrusted data, path traversal in file operations, unrestricted upload type or size, SSRF through a user-supplied URL, open redirect, zip-slip.
5. **Crypto and randomness** — \`Math.random\` for anything security-relevant, hardcoded IVs or salts, weak or homegrown algorithms, missing signature verification, disabled certificate validation.
6. **Web platform** — missing CSRF protection on state-changing requests, cookies without HttpOnly/Secure/SameSite, permissive CORS (\`*\` with credentials), a CSP weakened by the change.
7. **Dependencies and config** — a newly added dependency with a known-bad reputation, a version pin loosened, a security flag flipped off, debug or verbose mode enabled in a production path.

For each candidate finding, state the attack: who the attacker is, what they send, and what they get. If you cannot construct that path from the code you read, it is not a finding — drop it or report it as Low with the uncertainty named.

${REVIEW_OUTPUT_CONTRACT}`;

const SHELL_PROMPT = `You are a shell subagent. Run the shell commands described in the prompt and return trimmed, actionable output.

- Combine related commands with && when order matters; run independent checks in parallel where possible.
- Trim verbose output to what matters: exit codes, errors, and the lines that answer the question.
- Do not start background dev servers unless the prompt explicitly asks.
- Report every command's exit code when non-zero.
- Do not stop early: run every command requested and summarize results.`;

const BROWSER_PROMPT = `You are a browser subagent. Verify or explore web UIs using the browser_* tools.

1. browser_navigate to the target URL.
2. browser_snapshot to inspect structure — use returned selectors; do not guess.
3. Interact with browser_click, browser_type, browser_press, browser_scroll as needed.
4. browser_screenshot at meaningful states; read saved screenshots when visual proof matters.
5. Check browser_console and browser_network for invisible failures.

Report what was verified (URL, interactions), screenshot paths, and any console/network issues. Never modify workspace files.`;

const DOCS_RESEARCHER_PROMPT = `You are a docs-researcher subagent. Fetch current library, framework, or CLI documentation.

- Use websearch and web_fetch to find official docs; prefer primary sources over blog posts.
- Return concise API examples with version notes when the docs specify them.
- Never fabricate API shapes, parameters, or behavior you did not read in the fetched docs.
- If docs are ambiguous or unavailable, say so explicitly.`;

const CI_INVESTIGATOR_PROMPT = `You are a ci-investigator subagent. Diagnose a single failing CI check.

- Use read-only bash (gh, git log, git diff) and read/grep to inspect logs and the failing change.
- Never modify the repository: no checkout, stash, commit, reset, or writes.
- Output a root-cause summary in at most 10 lines, then one concrete fix recommendation.
- If you cannot access logs or the repo, report exactly what blocked you.`;

/** Subagents shipped with Deyin. */
export const BUILTIN_SUBAGENTS: SubagentDefinition[] = [  {
    name: "explorer",
    description:
      "Fast read-only codebase exploration: find files, symbols, call sites and answer questions about structure. Use proactively for broad searches to keep noisy output out of the main context.",
    prompt:
      "You are a codebase exploration subagent. Investigate the question using read/grep/glob/ls only, in parallel where possible. Report findings as a compact, structured summary with exact file paths and line references. Never modify anything. Do not stop early: if information is missing, say so explicitly and report what you have.",
    readonly: true,
    isBackground: false,
    source: "built-in",
  },
  {
    name: "reviewer",
    description: "Independent second pass that critiques a diff or recent changes for correctness, security and style.",
    prompt:
      "You are a code review subagent. Review the changes described in the prompt: read the touched files, look for correctness bugs, security issues, missed edge cases and style drift. Report a prioritized list of findings with file:line references. Never modify anything. Do not stop early: if information is missing, mark it as uncertain and report what you have.",
    readonly: true,
    isBackground: false,
    source: "built-in",
  },
  {
    name: "bugbot",
    description:
      "Bugbot: adversarial bug hunt over a diff. Computes the diff itself from a repository path and reports only real, evidence-backed defects with severity and file:line. Use for /review-bugbot or when the user asks for a bug review of their changes.",
    prompt: BUGBOT_PROMPT,
    // Not `readonly` (which would gate every git command behind an approval
    // prompt); the tool allowlist is what makes the run non-destructive — no
    // write/edit tool is registered at all.
    tools: ["read", "grep", "glob", "ls", "bash", "codebase_search", "todo_write", "todo_read", "git_status", "git_log", "git_diff", "git_blame"],
    readonly: false,
    isBackground: false,
    effort: "high",
    maxSteps: 60,
    source: "built-in",
  },
  {
    name: "security-review",
    description:
      "Security Review: audits a diff for exploitable vulnerabilities — injection, authz gaps, secrets, unsafe deserialization, SSRF, path traversal. Computes the diff itself from a repository path. Use for /review-security or when the user asks for a security review of their changes.",
    prompt: SECURITY_REVIEW_PROMPT,
    // See the bugbot note: the allowlist, not `readonly`, enforces "never modify".
    tools: ["read", "grep", "glob", "ls", "bash", "codebase_search", "todo_write", "todo_read", "git_status", "git_log", "git_diff", "git_blame"],
    readonly: false,
    isBackground: false,
    effort: "high",
    maxSteps: 60,
    source: "built-in",
  },
  {
    name: "test-runner",
    description: "Runs the test suite (or a named subset) and reports failures with the relevant output.",
    prompt:
      "You are a test-runner subagent. Figure out how this project runs its tests (package.json scripts, Makefile, CI config), run the requested tests with bash, and report pass/fail with the failing output trimmed to what matters. Do not stop early: keep working until the requested tests have run and results are reported.",
    readonly: false,
    isBackground: false,
    source: "built-in",
  },
  {
    name: "shell",
    description:
      "Run shell command sequences and return trimmed output. Use for long builds, installs, or multi-step shell work that would clutter the main context.",
    prompt: SHELL_PROMPT,
    tools: ["bash", "read", "grep", "glob", "ls", "todo_write", "todo_read"],
    readonly: false,
    isBackground: false,
    maxSteps: 30,
    source: "built-in",
  },
  {
    name: "browser",
    description:
      "Browser automation for UI verification, scraping, or interaction that produces noisy DOM output. Use when browser tools are enabled.",
    prompt: BROWSER_PROMPT,
    tools: [
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_scroll",
      "browser_snapshot",
      "browser_screenshot",
      "browser_console",
      "browser_network",
      "read",
    ],
    readonly: true,
    isBackground: false,
    source: "built-in",
  },
  {
    name: "docs-researcher",
    description:
      "Fetch current library documentation and API references. Use when the task depends on up-to-date docs for a framework, SDK, or CLI.",
    prompt: DOCS_RESEARCHER_PROMPT,
    tools: ["web_fetch", "websearch", "read", "grep", "glob"],
    readonly: true,
    isBackground: false,
    effort: "medium",
    source: "built-in",
  },
  {
    name: "ci-investigator",
    description:
      "Investigate a failing CI check: fetch logs, identify root cause, return a short fix recommendation. Use when the user asks about a red CI check or PR failure.",
    prompt: CI_INVESTIGATOR_PROMPT,
    tools: ["bash", "read", "grep", "glob", "git_log", "git_diff", "git_status"],
    readonly: true,
    isBackground: false,
    effort: "high",
    maxSteps: 40,
    source: "built-in",
  },
];

/** Discover custom subagents: one markdown file per agent. */
export async function discoverSubagents(roots: CapabilityRoot[]): Promise<SubagentDefinition[]> {
  const byName = new Map<string, SubagentDefinition>();
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name) !== ".md") continue;
      const path = join(root.dir, entry.name);
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(raw);
      const name = (fmString(data, "name") ?? basename(entry.name, ".md")).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      if (!name || byName.has(name)) continue;
      byName.set(name, {
        name,
        description: fmString(data, "description") ?? `Custom subagent ${name}.`,
        prompt: body.trim() || `You are the ${name} subagent. Complete the delegated task and report back concisely.`,
        model: fmString(data, "model"),
        effort: fmEffort(data),
        maxSteps: fmNumber(data, "max_steps"),
        tools: fmStringList(data, "tools"),
        readonly: fmBool(data, "readonly") ?? false,
        isBackground: fmBool(data, "is_background") ?? false,
        source: root.source,
        path,
      });
    }
  }
  for (const builtin of BUILTIN_SUBAGENTS) {
    if (!byName.has(builtin.name)) byName.set(builtin.name, builtin);
  }
  return [...byName.values()];
}

/**
 * Resolve the effective reasoning effort for a subagent run: the validated
 * settings override wins, then the definition's frontmatter. Returns undefined
 * when neither is set, so no `reasoning_effort` is sent (providers that reject
 * the parameter keep working).
 */
export function subagentEffort(
  override: string | undefined,
  frontmatter: "low" | "medium" | "high" | undefined,
): "low" | "medium" | "high" | undefined {
  if (override === "low" || override === "medium" || override === "high") return override;
  return frontmatter;
}
