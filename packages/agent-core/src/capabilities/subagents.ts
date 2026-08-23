import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { BUGBOT_PROMPT, SECURITY_REVIEW_PROMPT } from "../review-contracts.js";
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
