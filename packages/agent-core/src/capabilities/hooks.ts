import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hooksFiles } from "./paths.js";

/**
 * Custom lifecycle hooks. hooks.json schema (Cursor-compatible subset):
 *
 * {
 *   "version": 1,
 *   "hooks": {
 *     "beforeShellExecution": [
 *       { "command": "./hooks/check.sh", "timeout": 30, "matcher": "curl|wget", "failClosed": false }
 *     ]
 *   }
 * }
 *
 * Execution: the hook command is spawned with the event payload as JSON on
 * stdin. Exit 0 = parse stdout as JSON output; exit 2 = block the action;
 * anything else = fail-open (unless failClosed). `matcher` is a regex tested
 * against the tool name / shell command, depending on the event.
 */

export type HookEvent = "sessionStart" | "preToolUse" | "postToolUse" | "beforeShellExecution" | "afterShellExecution" | "stop";

export const HOOK_EVENTS: HookEvent[] = [
  "sessionStart",
  "preToolUse",
  "postToolUse",
  "beforeShellExecution",
  "afterShellExecution",
  "stop",
];

export interface HookDefinition {
  command: string;
  /** Seconds; default 30. */
  timeout?: number;
  /** Regex matched against the event subject (tool name or command text). */
  matcher?: string;
  /** When true, a crashed/timed-out hook blocks instead of failing open. */
  failClosed?: boolean;
}

export interface LoadedHook extends HookDefinition {
  event: HookEvent;
  source: string;
  /** Directory hook commands run from (the hooks.json location's project root). */
  cwd: string;
  path: string;
}

interface HooksFile {
  version?: number;
  hooks?: Partial<Record<string, HookDefinition[]>>;
}

/** Load hooks.json from workspace + user locations. All matching hooks run. */
export async function loadHooks(cwd: string | null, userDir?: string): Promise<LoadedHook[]> {
  const loaded: LoadedHook[] = [];
  for (const file of hooksFiles(cwd, userDir)) {
    let raw: string;
    try {
      raw = await readFile(file.path, "utf8");
    } catch {
      continue;
    }
    let parsed: HooksFile;
    try {
      parsed = JSON.parse(raw) as HooksFile;
    } catch {
      continue;
    }
    const runFrom = file.source === "workspace" && cwd ? cwd : dirname(dirname(file.path));
    for (const [event, defs] of Object.entries(parsed.hooks ?? {})) {
      if (!HOOK_EVENTS.includes(event as HookEvent) || !Array.isArray(defs)) continue;
      for (const def of defs) {
        if (!def || typeof def.command !== "string" || !def.command) continue;
        loaded.push({
          ...def,
          event: event as HookEvent,
          source: file.source,
          cwd: runFrom,
          path: file.path,
        });
      }
    }
  }
  return loaded;
}

export interface HookOutcome {
  /** True when a hook blocked the action (exit 2, permission "deny", or failClosed failure). */
  blocked: boolean;
  /** Message shown to the user/model when blocked. */
  reason?: string;
  /** Extra context a hook asked to inject (sessionStart). */
  additionalContext?: string[];
}

interface HookStdout {
  permission?: "allow" | "deny" | "ask";
  user_message?: string;
  agent_message?: string;
  additional_context?: string;
}

/** Run every hook registered for an event whose matcher matches the subject. */
export async function runHooks(
  hooks: LoadedHook[],
  event: HookEvent,
  subject: string,
  payload: Record<string, unknown>,
): Promise<HookOutcome> {
  const outcome: HookOutcome = { blocked: false, additionalContext: [] };
  for (const hook of hooks) {
    if (hook.event !== event) continue;
    if (hook.matcher) {
      try {
        if (!new RegExp(hook.matcher).test(subject)) continue;
      } catch {
        continue; // invalid regex never matches
      }
    }
    const result = await runOneHook(hook, { hook_event_name: event, ...payload });
    if (result.output?.additional_context) outcome.additionalContext!.push(result.output.additional_context);
    const denied = result.exitCode === 2 || result.output?.permission === "deny";
    const failed = result.failed && hook.failClosed === true;
    if (denied || failed) {
      outcome.blocked = true;
      outcome.reason =
        result.output?.agent_message ??
        result.output?.user_message ??
        (denied ? `Blocked by ${hook.event} hook (${hook.command}).` : `Hook ${hook.command} failed and is failClosed.`);
      return outcome;
    }
  }
  return outcome;
}

function runOneHook(
  hook: LoadedHook,
  payload: Record<string, unknown>,
): Promise<{ exitCode: number | null; failed: boolean; output?: HookStdout }> {
  return new Promise((resolve) => {
    const timeoutMs = Math.max(1, hook.timeout ?? 30) * 1000;
    let child;
    try {
      child = spawn(hook.command, {
        shell: true,
        cwd: hook.cwd,
        env: { ...process.env, DEYIN_PROJECT_DIR: hook.cwd },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve({ exitCode: null, failed: true });
      return;
    }

    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolve({ exitCode: null, failed: true });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, failed: true });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let output: HookStdout | undefined;
      try {
        output = JSON.parse(stdout) as HookStdout;
      } catch {
        output = undefined;
      }
      resolve({ exitCode: code, failed: code !== 0 && code !== 2, output });
    });

    // Hooks may exit without reading stdin (e.g. `exit 2`); EPIPE arrives
    // asynchronously on the stream and must not crash the host.
    child.stdin.on("error", () => undefined);
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      // Command may exit before reading stdin; the close handler settles.
    }
  });
}
