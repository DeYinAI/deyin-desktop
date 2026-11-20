/**
 * Automations tool family: lets the agent create, inspect, and run scheduled
 * automations through the same AutomationService the Automations UI uses, so
 * persistence (automations.json) and scheduler wiring happen exactly like a
 * hand-entered automation — no restart or renderer round-trip needed.
 */
import type { ToolDefinition } from "@deyin/agent-core";
import type {
 Automation,
 AutomationLimits,
 AutomationRun,
 AutomationPayload,
 AutomationTarget,
 AutomationTrigger,
} from "@deyin/host-core";
import { resolveLimits, type SettingsStore } from "@deyin/host-core";
import { consentError, consentOrigins, normalizeOrigin } from "./automations/consent.js";
import { describeRunDetail, describeRunLine, stamp } from "./automations/run-report.js";
import type { AutomationService } from "./automations/service.js";

function str(args: Record<string, unknown>, key: string): string {
 const v = args[key];
 return typeof v === "string" ? v.trim() : "";
}

function parseTarget(args: Record<string, unknown>): AutomationTarget {
 const kind = str(args, "targetKind") || "local";
 const workspacePath = str(args, "workspacePath");
 if (kind === "local") {
 if (!workspacePath) throw new Error("workspacePath is required (absolute path on this machine).");
 return { kind: "local", workspacePath };
 }
 const distro = str(args, "distro");
 if (!distro) throw new Error("distro is required for wsl targets.");
 if (!workspacePath) throw new Error("workspacePath is required for wsl targets.");
 return { kind: "wsl", distro, workspacePath };
}

function parseTrigger(args: Record<string, unknown>): AutomationTrigger {
 const runAt = str(args, "runAt");
 if (runAt) {
 const at = Date.parse(runAt);
 if (!Number.isFinite(at)) throw new Error(`runAt "${runAt}" is not a valid ISO 8601 date-time.`);
 if (at <= Date.now()) throw new Error("runAt must be in the future.");
 return { kind: "once", at };
 }
 const cron = str(args, "cron");
 if (!cron) return { kind: "manual" };
 return { kind: "cron", expression: cron };
}

function describeTrigger(trigger: AutomationTrigger): string {
 if (trigger.kind === "cron") return `cron ${trigger.expression}`;
 if (trigger.kind === "once") return `once at ${new Date(trigger.at).toISOString()}`;
 return "manual";
}

/** The limit fields an agent passed, or undefined when it passed none. Out-of-range values are rejected by the service. */
function parseLimits(args: Record<string, unknown>): Partial<AutomationLimits> | undefined {
 const limits: Partial<AutomationLimits> = {};
 for (const key of ["maxMinutes", "idleMinutes", "maxSteps"] as const) {
  if (args[key] !== undefined) limits[key] = args[key] as number;
 }
 return Object.keys(limits).length > 0 ? limits : undefined;
}

/** A list argument, or undefined when it was not passed. An empty list is a deliberate "none". */
function parseList(args: Record<string, unknown>, key: string): string[] | undefined {
 const value = args[key];
 if (value === undefined) return undefined;
 if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${key} must be a list of strings.`);
 return (value as string[]).map((item) => item.trim()).filter(Boolean);
}

/** Browser consent from `browserSites`, normalized to origins; undefined when not passed. Throws on anything that is not a site. */
function parseConsent(args: Record<string, unknown>): Automation["consent"] | undefined {
 const sites = parseList(args, "browserSites");
 if (sites === undefined) return undefined;
 const problem = consentError(sites);
 if (problem) throw new Error(problem);
 return { browserOrigins: [...new Set(sites.map((site) => normalizeOrigin(site) as string))] };
}

/** Tool requirements from `requiredTools`; undefined when not passed. */
function parseRequires(args: Record<string, unknown>, existing?: Automation["requires"]): Automation["requires"] | undefined {
 const tools = parseList(args, "requiredTools");
 if (tools === undefined) return undefined;
 return { ...existing, tools };
}

/** What an unwell automation needs the reader to know: paused, or failing repeatedly. */
function describeHealth(a: Automation): string {
 const health = a.health;
 if (!health) return "";
 if (health.pausedAt) return `, PAUSED (${health.pausedKind ?? "other"}: ${health.pausedReason ?? "no reason recorded"})`;
 if (health.consecutiveFailures > 0) return `, ${health.consecutiveFailures} failed run(s) in a row`;
 return "";
}

/** Shown only when the automation overrides the defaults (15 minutes, 5 quiet, 120 steps). */
function describeLimits(a: Automation): string {
 if (!a.limits) return "";
 const l = resolveLimits(a);
 return `, limits ${l.maxMinutes}m run / ${l.idleMinutes}m quiet / ${l.maxSteps} steps`;
}

/** What a person approving the call must see: it grants access to their signed-in browser. */
function browserNote(args: Record<string, unknown>): string {
 const sites = Array.isArray(args.browserSites) ? args.browserSites.filter((s): s is string => typeof s === "string") : [];
 return sites.length > 0 ? ` — grants Chrome access to ${sites.join(", ")}` : "";
}

/** Shown only when the automation may use the user's Chrome: the sites, because that is the grant. */
function describeBrowser(a: Automation): string {
 const origins = consentOrigins(a);
 return origins.length > 0 ? `, may use Chrome on ${origins.join(" ")}` : "";
}

/** Self-healing is on unless switched off; say so only when there is something to know. */
function describeHealing(a: Automation): string {
 const parts: string[] = [];
 if (a.autoHeal === false) parts.push("self-healing off");
 const rules = a.learnedRules?.length ?? 0;
 if (rules > 0) {
  const onProbation = a.learnedRevisions?.some((revision) => revision.status === "probation");
  parts.push(`${rules} learned rule${rules === 1 ? "" : "s"}${onProbation ? " (latest patch on probation)" : ""}`);
 }
 return parts.length > 0 ? `, ${parts.join(", ")}` : "";
}

/** One-line human summary of an automation for tool results. */
function describe(a: Automation): string {
 const schedule = describeTrigger(a.trigger);
 const target =
 a.target.kind === "local"
 ? `local @ ${a.target.workspacePath}`
 : a.target.kind === "wsl"
 ? `wsl(${a.target.distro}) @ ${a.target.workspacePath}`
 : `ssh host ${a.target.hostId}`;
 return `${a.name} (id ${a.id}) — ${schedule}, ${target}, ${a.enabled ? "enabled" : "disabled"}, model ${a.providerId}::${a.model}${describeLimits(a)}${describeBrowser(a)}${describeHealing(a)}${describeHealth(a)}`;
}

function buildInput(
 args: Record<string, unknown>,
 settings: SettingsStore,
): Omit<Automation, "id" | "createdAt" | "updatedAt"> {
 const name = str(args, "name");
 if (!name) throw new Error("name is required.");
 const prompt = str(args, "prompt");
 if (!prompt) throw new Error("prompt is required.");
 const enabled = args.enable === undefined ? true : args.enable === true;

 const payload: AutomationPayload = { kind: "prompt", prompt };
 const target = parseTarget(args);
 const trigger = parseTrigger(args);
 const providerId = str(args, "providerId") || "openference";
 let model = str(args, "model");
 if (!model) {
 model = settings.get().defaultModel?.split("::")[1] ?? "";
 }
 if (!model) {
 throw new Error(
 "No model given and no app default model is configured — pass model explicitly.",
 );
 }

 const limits = parseLimits(args);
 const consent = parseConsent(args);
 const requires = parseRequires(args);

 return {
 name,
 description: str(args, "description"),
 enabled,
 payload,
 trigger,
 target,
 model,
 providerId,
 ...(limits ? { limits } : {}),
 ...(consent?.browserOrigins.length ? { consent } : {}),
 ...(requires?.tools?.length ? { requires } : {}),
 ...(args.autoHeal === false ? { autoHeal: false } : {}),
 };
}

/** Finds the run `runId` names (a unique prefix is enough), or the live run of automation `id`. */
function findRun(service: AutomationService, args: Record<string, unknown>): AutomationRun | string {
 const runId = str(args, "runId");
 const id = str(args, "id");
 if (!runId && !id) return "Pass runId, or the automation id to stop its current run.";
 if (runId) {
  const matches = service.listRuns().filter((r) => r.id === runId || r.id.startsWith(runId));
  if (matches.length === 0) return `No run matches ${runId}.`;
  if (matches.length > 1) return `${runId} matches ${matches.length} runs; pass more of the id.`;
  return matches[0]!;
 }
 const live = service.listRuns(id).find((r) => r.status === "running" || r.status === "queued");
 return live ?? `Automation ${id} has no run in progress.`;
}

/** Poll a freshly started run briefly so the agent sees the outcome in-turn. */
async function waitForRun(
 service: AutomationService,
 automationId: string,
 runId: string,
 timeoutMs: number,
): Promise<string> {
 const deadline = Date.now() + timeoutMs;
 while (Date.now() < deadline) {
 await new Promise((r) => setTimeout(r, 3000));
 const run = service.listRuns(automationId).find((r) => r.id === runId);
 if (!run) return `Run ${runId} started (status unknown — check Run History).`;
 if (run.status === "completed" || run.status === "failed" || run.status === "aborted") {
 const tail = (run.finalText ?? "").trim().slice(0, 400);
 return `Run ${run.id} ${run.status}.\n${run.status === "failed" ? `Error: ${run.reason ?? "unknown"}` : tail ? `Final output (truncated): ${tail}` : "(no output text)"}`;
 }
 }
 return `Run ${runId} still running. See what it has done so far with automation_runs {runId: "${runId}", detail: true}, or end it with automation_stop {runId: "${runId}"}.`;
}

export function createAutomationTools(
 service: AutomationService,
 settings: SettingsStore,
): ToolDefinition[] {
 const createTool: ToolDefinition = {
 name: "automation_create",
 description:
 "Create a scheduled automation that runs an agent prompt on this machine (or WSL/SSH). Persists immediately and arms the scheduler — no app restart needed. The prompt can use web search, write files, etc.",
 tier: "write",
 parameters: {
 type: "object",
 properties: {
 name: { type: "string", description: "Short display name, e.g. 'Daily frontier-model news digest'." },
 description: { type: "string", description: "Optional longer description." },
 prompt: { type: "string", description: "The prompt the agent runs on every scheduled execution." },
 cron: { type: "string", description: "5-field cron expression (e.g. '0 8 * * *' = daily 08:00). Omit for a manual (run-on-demand) automation." },
 runAt: { type: "string", description: "ISO 8601 date-time (with offset) for a one-shot run, e.g. '2026-12-01T09:00:00+01:00'. Takes precedence over cron; the automation ends after it runs." },
 workspacePath: { type: "string", description: "Absolute path of the workspace the agent runs in." },
 targetKind: { type: "string", enum: ["local", "wsl"], description: "Defaults to local. wsl requires distro." },
 distro: { type: "string", description: "WSL distro name when targetKind=wsl (e.g. Ubuntu-22.04)." },
 model: { type: "string", description: "Model id; defaults to the app's current default model." },
 providerId: { type: "string", description: "Provider id; defaults to openference (required for non-local targets)." },
 enable: { type: "boolean", description: "Start scheduled runs immediately (default true)." },
 maxMinutes: { type: "number", description: "Longest a single run may take, 1-240 (default 15). The run is stopped and recorded as failed past it." },
 idleMinutes: { type: "number", description: "Longest a run may go without any progress, 1-60 (default 5)." },
 maxSteps: { type: "number", description: "Most model steps a run may take, 1-1000 (default 120)." },
 browserSites: { type: "array", items: { type: "string" }, description: "Sites this automation may use in the user's own Chrome, as origins (e.g. [\"https://x.com\"]). This is a grant to act as the user on those sites: ask the user before adding one, and never add a site the task does not need. Each site must also be approved for Chrome control in Settings. Without it the automation has no Chrome access and reports blocked." },
 autoHeal: { type: "boolean", description: "Let the app add short learned rules to this automation after failed runs (default true). Rules only refine how a run goes about the task, are rolled back if the next run fails again, and can be reviewed and reverted in the Automations view." },
 requiredTools: { type: "array", items: { type: "string" }, description: "Tool names or patterns the automation cannot work without (e.g. [\"chrome_*\"]). If one is missing at run time the run reports blocked instead of improvising." },
 },
 required: ["name", "prompt", "workspacePath"],
 },
 summarize: (args) => `create automation ${str(args, "name") || "(unnamed)"}${browserNote(args)}`,
    execute: async (args) => {
      const input = buildInput(args, settings);
      const mutation = service.create(input);
      let scheduleMsg: string;
      const trigger = mutation.automation.trigger;
      if (trigger.kind !== "manual") {
        const when = describeTrigger(trigger);
        scheduleMsg = mutation.automation.enabled
          ? `Scheduled runs are active (${when}).`
          : `Saved with schedule ${when}, but disabled — enable it before expecting scheduled runs.`;
      } else {
        scheduleMsg = `Created as a manual-only (run-on-demand) automation because no cron schedule was specified. Scheduled runs are NOT active. To run it, use automation_run with id ${mutation.automation.id}, or update it with a cron schedule via automation_update.`;
      }
      return `Created automation "${mutation.automation.name}" (id ${mutation.automation.id}). ${scheduleMsg}`;
    },
 };

 const listTool: ToolDefinition = {
 name: "automation_list",
 description:
 "List automations with their schedule, target, model and enabled state. Includes the most recent run per automation.",
 tier: "read",
 parameters: { type: "object", properties: {}, required: [] },
 summarize: () => "list automations",
 execute: async () => {
 const all = service.list();
 if (all.length === 0) return "No automations saved.";
 return all
 .map((a) => {
 const last = a.lastRun
 ? ` Last run: ${a.lastRun.status} at ${stamp(a.lastRun.startedAt)}.`
 : "";
 return `${describe(a)}.${last}`;
 })
 .join("\n");
 },
 };

 const runsTool: ToolDefinition = {
 name: "automation_runs",
 description:
 "Show recent runs for one automation or all of them: status, outcome, timestamps and the start of the output. Pass detail=true for the full record of a run — every tool call with its result, the blocker, what it produced and the whole final output. Use that before concluding a run is stuck or has failed.",
 tier: "read",
 parameters: {
 type: "object",
 properties: {
 id: { type: "string", description: "Automation id to scope to; omit for all." },
 runId: { type: "string", description: "Show only this run (a unique prefix of its id is enough)." },
 limit: { type: "number", description: "Max runs to show (default 5; default 1 with detail)." },
 detail: { type: "boolean", description: "Full record of each run: tool-call timeline and entire final output." },
 },
 required: [],
 },
 summarize: (args) => `list automation runs${args.id ? ` for ${String(args.id)}` : ""}`,
 execute: async (args) => {
 const id = str(args, "id");
 const runId = str(args, "runId");
 const detail = args.detail === true;
 const limitRaw = args.limit;
 const limit =
 typeof limitRaw === "number" && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 20) : detail ? 1 : 5;
 const all = service.listRuns(id || undefined);
 const runs = (runId ? all.filter((r) => r.id === runId || r.id.startsWith(runId)) : all).slice(0, limit);
 if (runs.length === 0) return "No runs recorded.";
 return runs.map(detail ? describeRunDetail : describeRunLine).join(detail ? "\n\n" : "\n");
 },
 };

 const stopTool: ToolDefinition = {
 name: "automation_stop",
 description:
 "Stop a run that is in progress (the Stop button in Run History). Give the run id, or the automation id to stop its current run. The run is recorded as stopped by you; it does not count against the automation's health.",
 tier: "write",
 parameters: {
 type: "object",
 properties: {
 runId: { type: "string", description: "Run id (from automation_runs)." },
 id: { type: "string", description: "Automation id; stops its current run." },
 },
 required: [],
 },
 summarize: (args) => `stop automation run ${str(args, "runId") || str(args, "id") || "(id?)"}`,
 execute: async (args) => {
 const found = findRun(service, args);
 if (typeof found === "string") return found;
 if (found.status !== "running" && found.status !== "queued") {
  return `Run ${found.id} already ${found.status}${found.outcome ? ` (${found.outcome})` : ""}; nothing to stop.`;
 }
 service.stopRun(found.id);
 return `Stop requested for run ${found.id}. Check automation_runs {runId: "${found.id}", detail: true} for how it ended.`;
 },
 };

 const runTool: ToolDefinition = {
 name: "automation_run",
 description:
 "Trigger an automation immediately (same as the Run now button) and wait briefly for it to finish.",
 tier: "execute",
 parameters: {
 type: "object",
 properties: {
 id: { type: "string", description: "Automation id to run." },
 waitSeconds: { type: "number", description: "How long to wait for completion before returning (default 90, max 300)." },
 },
 required: ["id"],
 },
 summarize: (args) => `run automation ${str(args, "id") || "(id?)"}`,
 execute: async (args) => {
 const id = str(args, "id");
 if (!id) throw new Error("id is required.");
 const run = service.run(id);
 const waitRaw = args.waitSeconds;
 const waitSeconds =
 typeof waitRaw === "number" && waitRaw > 0 ? Math.min(Math.floor(waitRaw), 300) : 90;
 return waitForRun(service, id, run.id, waitSeconds * 1000);
 },
 };

 const updateTool: ToolDefinition = {
 name: "automation_update",
 description:
 "Update an existing automation: rename, change description/prompt/cron/workspace/target/model, enable or disable it.",
 tier: "write",
 parameters: {
 type: "object",
 properties: {
 id: { type: "string", description: "Automation id (from automation_list)." },
 name: { type: "string", description: "New display name." },
 description: { type: "string", description: "New description." },
 prompt: { type: "string", description: "Replacement prompt." },
 cron: { type: "string", description: "New cron expression; empty string switches to manual." },
 runAt: { type: "string", description: "ISO 8601 date-time for a one-shot run (replaces the schedule)." },
 workspacePath: { type: "string", description: "New workspace path." },
 targetKind: { type: "string", enum: ["local", "wsl"], description: "New target kind." },
 distro: { type: "string", description: "WSL distro when targetKind=wsl." },
 model: { type: "string", description: "New model id." },
 enable: { type: "boolean", description: "Enabled state." },
 maxMinutes: { type: "number", description: "Longest a single run may take, 1-240." },
 idleMinutes: { type: "number", description: "Longest a run may go without any progress, 1-60." },
 maxSteps: { type: "number", description: "Most model steps a run may take, 1-1000." },
 browserSites: { type: "array", items: { type: "string" }, description: "Sites this automation may use in the user's own Chrome, as origins (e.g. [\"https://x.com\"]). This is a grant to act as the user on those sites: ask the user before adding one, and never add a site the task does not need. Each site must also be approved for Chrome control in Settings. Replaces the current list; an empty list removes Chrome access." },
 autoHeal: { type: "boolean", description: "Let the app add short learned rules to this automation after failed runs (on unless switched off). Rules only refine how a run goes about the task, are rolled back if the next run fails again, and can be reviewed and reverted in the Automations view." },
 requiredTools: { type: "array", items: { type: "string" }, description: "Replaces the current list; tool names or patterns the automation cannot work without (e.g. [\"chrome_*\"]). If one is missing at run time the run reports blocked instead of improvising." },
 },
 required: ["id"],
 },
 summarize: (args) => `update automation ${str(args, "id") || "(id?)"}${browserNote(args)}`,
 execute: async (args) => {
 const id = str(args, "id");
 const existing = service.list().find((a) => a.id === id);
 if (!existing) throw new Error(`Automation ${id} not found.`);

 const patch: Partial<Omit<Automation, "id" | "createdAt">> = {};
 const name = str(args, "name");
 if (name) patch.name = name;
 if (args.description !== undefined) patch.description = str(args, "description");
 const prompt = str(args, "prompt");
 if (prompt) patch.payload = { kind: "prompt", prompt };
 if (args.cron !== undefined || args.runAt !== undefined) patch.trigger = parseTrigger(args);
 if (args.targetKind !== undefined || args.workspacePath !== undefined || args.distro !== undefined) {
 patch.target = parseTarget({
 ...args,
 workspacePath: str(args, "workspacePath") || existing.target.workspacePath,
 targetKind: str(args, "targetKind") || existing.target.kind,
 distro: str(args, "distro") || (existing.target.kind === "wsl" ? existing.target.distro : ""),
 });
 }
 const model = str(args, "model");
 if (model) {
 patch.model = model;
 patch.providerId = str(args, "providerId") || existing.providerId;
 }
 if (args.enable !== undefined) patch.enabled = args.enable === true;
 const limits = parseLimits(args);
 if (limits) patch.limits = { ...existing.limits, ...limits };
 const consent = parseConsent(args);
 if (consent) patch.consent = consent;
 const requires = parseRequires(args, existing.requires);
 if (requires) patch.requires = requires;
 if (args.autoHeal !== undefined) patch.autoHeal = args.autoHeal === true;
 if (Object.keys(patch).length === 0) return "Nothing to update.";

 service.update(id, patch);
 const updated = service.list().find((a) => a.id === id) ?? existing;
 return `Updated. Now: ${describe(updated)}.`;
 },
 };

 const deleteTool: ToolDefinition = {
 name: "automation_delete",
 description: "Permanently delete an automation (its run history stays).",
 tier: "write",
 parameters: {
 type: "object",
 properties: { id: { type: "string", description: "Automation id to delete." } },
 required: ["id"],
 },
 summarize: (args) => `delete automation ${str(args, "id") || "(id?)"}`,
 execute: async (args) => {
 const id = str(args, "id");
 if (!id) throw new Error("id is required.");
 service.remove(id);
 return `Deleted automation ${id}.`;
 },
 };

 return [createTool, listTool, runsTool, runTool, stopTool, updateTool, deleteTool];
}
