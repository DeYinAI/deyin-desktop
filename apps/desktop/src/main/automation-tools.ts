/**
 * Automations tool family: lets the agent create, inspect, and run scheduled
 * automations through the same AutomationService the Automations UI uses, so
 * persistence (automations.json) and scheduler wiring happen exactly like a
 * hand-entered automation — no restart or renderer round-trip needed.
 */
import type { ToolDefinition } from "@deyin/agent-core";
import type {
 Automation,
 AutomationPayload,
 AutomationTarget,
 AutomationTrigger,
} from "@deyin/host-core";
import type { SettingsStore } from "@deyin/host-core";
import type { AutomationService } from "./automations/service.js";

/** "2026-09-02T14:03:00Z"-style stamp for run listings. */
function stamp(ms?: number): string {
 return ms ? new Date(ms).toISOString() : "—";
}

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
 const cron = str(args, "cron");
 if (!cron) return { kind: "manual" };
 return { kind: "cron", expression: cron };
}

/** One-line human summary of an automation for tool results. */
function describe(a: Automation): string {
 const schedule =
 a.trigger.kind === "cron" ? `cron ${a.trigger.expression}` : "manual";
 const target =
 a.target.kind === "local"
 ? `local @ ${a.target.workspacePath}`
 : a.target.kind === "wsl"
 ? `wsl(${a.target.distro}) @ ${a.target.workspacePath}`
 : `ssh host ${a.target.hostId}`;
 return `${a.name} (id ${a.id}) — ${schedule}, ${target}, ${a.enabled ? "enabled" : "disabled"}, model ${a.providerId}::${a.model}`;
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

 return {
 name,
 description: str(args, "description"),
 enabled,
 payload,
 trigger,
 target,
 model,
 providerId,
 };
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
 return `Run ${runId} still running — check Run History in Automations, or the desktop notification when it finishes.`;
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
 workspacePath: { type: "string", description: "Absolute path of the workspace the agent runs in." },
 targetKind: { type: "string", enum: ["local", "wsl"], description: "Defaults to local. wsl requires distro." },
 distro: { type: "string", description: "WSL distro name when targetKind=wsl (e.g. Ubuntu-22.04)." },
 model: { type: "string", description: "Model id; defaults to the app's current default model." },
 providerId: { type: "string", description: "Provider id; defaults to openference (required for non-local targets)." },
 enable: { type: "boolean", description: "Start scheduled runs immediately (default true)." },
 },
 required: ["name", "prompt", "workspacePath"],
 },
 summarize: (args) => `create automation ${str(args, "name") || "(unnamed)"}`,
 execute: async (args) => {
 const input = buildInput(args, settings);
 const mutation = service.create(input);
 return `Created automation "${mutation.automation.name}" (id ${mutation.automation.id}). ${mutation.automation.enabled ? "Scheduled runs are active." : "It is saved disabled — enable it before expecting scheduled runs."}`;
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
 "Show recent runs (status, timestamps, final output) for one automation or all of them.",
 tier: "read",
 parameters: {
 type: "object",
 properties: {
 id: { type: "string", description: "Automation id to scope to; omit for all." },
 limit: { type: "number", description: "Max runs to show (default 5)." },
 },
 required: [],
 },
 summarize: (args) => `list automation runs${args.id ? ` for ${String(args.id)}` : ""}`,
 execute: async (args) => {
 const id = str(args, "id");
 const limitRaw = args.limit;
 const limit =
 typeof limitRaw === "number" && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 20) : 5;
 const runs = service.listRuns(id || undefined).slice(0, limit);
 if (runs.length === 0) return "No runs recorded.";
 return runs
 .map(
 (r) =>
 `${r.id} — ${r.status}, started ${stamp(r.startedAt)}, finished ${stamp(r.finishedAt)}${r.reason ? `, reason: ${r.reason}` : r.finalText ? `, output: ${r.finalText.trim().slice(0, 200)}` : ""}`,
 )
 .join("\n");
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
 workspacePath: { type: "string", description: "New workspace path." },
 targetKind: { type: "string", enum: ["local", "wsl"], description: "New target kind." },
 distro: { type: "string", description: "WSL distro when targetKind=wsl." },
 model: { type: "string", description: "New model id." },
 enable: { type: "boolean", description: "Enabled state." },
 },
 required: ["id"],
 },
 summarize: (args) => `update automation ${str(args, "id") || "(id?)"}`,
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
 if (args.cron !== undefined) patch.trigger = parseTrigger(args);
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

 return [createTool, listTool, runsTool, runTool, updateTool, deleteTool];
}
