import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  PermissionEngine,
  discoverSubagents,
  parseFrontmatter,
  runSubagent,
  subagentReadonlyRules,
  subagentRoots,
  type SubagentDefinition,
} from "@deyin/agent-core";
import type { CliContext } from "../context.js";
import { tokenSource } from "../context.js";
import { bold, dim, green, red, yellow } from "../output.js";

const EFFORTS = ["low", "medium", "high"] as const;

function agentsDir(ctx: CliContext, scope: "project" | "global"): string {
  return scope === "global" ? join(homedir(), ".deyin", "agents") : join(ctx.cwd, ".deyin", "agents");
}

/** Serialize a subagent definition to the same frontmatter format discoverSubagents parses. */
function serializeSubagent(name: string, input: SubagentInput, body: string): string {
  const fm: string[] = ["---", `name: ${name}`];
  if (input.description) fm.push(`description: ${quote(input.description)}`);
  if (input.model) fm.push(`model: ${input.model}`);
  if (input.effort) fm.push(`effort: ${input.effort}`);
  if (input.maxSteps !== undefined) fm.push(`max_steps: ${input.maxSteps}`);
  if (input.readonly !== undefined) fm.push(`readonly: ${input.readonly}`);
  if (input.isBackground !== undefined) fm.push(`is_background: ${input.isBackground}`);
  if (input.tools && input.tools.length > 0) fm.push(`tools: [${input.tools.join(", ")}]`);
  fm.push("---");
  return `${fm.join("\n")}\n${body.trim()}\n`;
}

function quote(value: string): string {
  // Keep values with colons/special chars safely quoted for the flat parser.
  return /[:#\[\],]/.test(value) ? JSON.stringify(value) : value;
}

export interface SubagentInput {
  description?: string;
  prompt?: string;
  model?: string;
  effort?: string;
  maxSteps?: number;
  readonly?: boolean;
  isBackground?: boolean;
  tools?: string[];
}

function validateInput(input: SubagentInput): string | null {
  if (input.effort && !EFFORTS.includes(input.effort as (typeof EFFORTS)[number])) {
    return `effort must be one of: ${EFFORTS.join(", ")}.`;
  }
  if (input.maxSteps !== undefined && (!Number.isInteger(input.maxSteps) || input.maxSteps < 1)) {
    return "max_steps must be a positive integer.";
  }
  return null;
}

async function discover(ctx: CliContext): Promise<SubagentDefinition[]> {
  return discoverSubagents(subagentRoots(ctx.cwd, homedir()));
}

export async function subagentsListCommand(ctx: CliContext): Promise<number> {
  const subs = await discover(ctx);
  if (subs.length === 0) {
    console.log("No subagents. Create one with `deyin subagent create <name> --description \"...\" --prompt \"...\"`.");
    return 0;
  }
  for (const s of subs) {
    const marks: string[] = [];
    if (s.model) marks.push(dim(`model: ${s.model}`));
    if (s.effort) marks.push(dim(`effort: ${s.effort}`));
    if (s.maxSteps) marks.push(dim(`max_steps: ${s.maxSteps}`));
    if (s.readonly) marks.push(dim("readonly"));
    if (s.isBackground) marks.push(dim("background"));
    if (s.tools?.length) marks.push(dim(`tools: ${s.tools.join(",")}`));
    if (s.source !== "built-in") marks.push(dim(s.path ? `(${s.source})` : `(${s.source})`));
    console.log(`${bold(s.name.padEnd(16))} ${s.description} ${marks.join("  ")}`);
  }
  console.log(dim(`\nInvoke from chat: "use the ${subs[0]!.name} subagent to ..." · run directly: \`deyin subagent run <name> "task"\``));
  return 0;
}

export async function subagentsCreateCommand(
  ctx: CliContext,
  args: { name?: string; description?: string; prompt?: string; "prompt-file"?: string; model?: string; effort?: string; "max-steps"?: string; readonly?: boolean; background?: boolean; tools?: string; scope?: string },
): Promise<number> {
  const name = (args.name ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!/^[a-z0-9._-]+$/.test(name)) {
    console.error(`${red("error:")} subagent name must be lowercase letters, digits, \`_\`, \`-\`, or \`.\`.`);
    return 1;
  }
  const existing = await discover(ctx);
  if (existing.some((s) => s.name === name)) {
    console.error(`${red("error:")} subagent "${name}" already exists (${existing.find((s) => s.name === name)!.source}).`);
    return 1;
  }
  const description = args.description?.trim();
  if (!description) {
    console.error(`${red("error:")} --description is required.`);
    return 1;
  }
  let prompt = args.prompt?.trim();
  if (args["prompt-file"]) {
    try {
      prompt = readFileSync(args["prompt-file"], "utf8").trim();
    } catch (err) {
      console.error(`${red("error:")} cannot read prompt file: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (!prompt) {
    console.error(`${red("error:")} --prompt or --prompt-file is required.`);
    return 1;
  }
  const input: SubagentInput = {
    description,
    prompt,
    model: args.model?.trim() || undefined,
    effort: args.effort?.trim().toLowerCase() || undefined,
    maxSteps: args["max-steps"] !== undefined && args["max-steps"] !== "" ? Number(args["max-steps"]) : undefined,
    readonly: args.readonly,
    isBackground: args.background,
    tools: args.tools ? args.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
  };
  const invalid = validateInput(input);
  if (invalid) {
    console.error(`${red("error:")} ${invalid}`);
    return 1;
  }
  const scope = args.scope === "global" ? "global" : "project";
  const dir = agentsDir(ctx, scope);
  const path = join(dir, `${name}.md`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, serializeSubagent(name, input, prompt), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.error(`${red("error:")} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.log(`${green("created")} ${name} (${scope}) → ${path}`);
  console.log(dim("It is now available to the desktop (Settings → Subagents) and the CLI task tool."));
  return 0;
}

export async function subagentsEditCommand(
  ctx: CliContext,
  args: { name?: string; description?: string; prompt?: string; "prompt-file"?: string; model?: string; effort?: string; "max-steps"?: string; readonly?: boolean; background?: boolean; tools?: string; scope?: string },
): Promise<number> {
  const name = (args.name ?? "").trim().toLowerCase();
  const target = (await discover(ctx)).find((s) => s.name === name);
  if (!target) {
    console.error(`${red("error:")} subagent "${name}" not found.`);
    return 1;
  }
  if (target.source === "built-in" || !target.path) {
    console.error(`${red("error:")} "${name}" is a built-in subagent; it cannot be edited. Override its model in Settings or config instead.`);
    return 1;
  }
  const raw = readFileSync(target.path, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const fields = { ...data } as Record<string, string | number | boolean | string[]>;
  if (args.description !== undefined) fields.description = args.description.trim();
  if (args.prompt !== undefined) fields.prompt = undefined as never; // body handles prompt
  const updatedBody = args.prompt !== undefined ? args.prompt.trim() : args["prompt-file"] ? readFileSync(args["prompt-file"], "utf8").trim() : body.trim();
  if (args.model !== undefined) args.model.trim() ? (fields.model = args.model.trim()) : delete fields.model;
  if (args.effort !== undefined) args.effort.trim() ? (fields.effort = args.effort.trim().toLowerCase()) : delete fields.effort;
  if (args["max-steps"] !== undefined) {
    const n = args["max-steps"] === "" ? undefined : Number(args["max-steps"]);
    if (n === undefined) delete fields.max_steps;
    else fields.max_steps = n;
  }
  if (args.readonly !== undefined) fields.readonly = args.readonly;
  if (args.background !== undefined) fields.is_background = args.background;
  if (args.tools !== undefined) fields.tools = args.tools.split(",").map((t) => t.trim()).filter(Boolean);
  const effort = typeof fields.effort === "string" ? fields.effort : undefined;
  const maxSteps = typeof fields.max_steps === "number" ? fields.max_steps : Number(fields.max_steps);
  const input: SubagentInput = {
    description: typeof fields.description === "string" ? fields.description : undefined,
    model: typeof fields.model === "string" ? fields.model : undefined,
    effort,
    maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : undefined,
    readonly: typeof fields.readonly === "boolean" ? fields.readonly : undefined,
    isBackground: typeof fields.is_background === "boolean" ? fields.is_background : undefined,
    tools: Array.isArray(fields.tools) ? fields.tools.filter((t): t is string => typeof t === "string") : undefined,
  };
  const invalid = validateInput(input);
  if (invalid) {
    console.error(`${red("error:")} ${invalid}`);
    return 1;
  }
  writeFileSync(target.path, serializeSubagent(name, input, updatedBody), { encoding: "utf8", mode: 0o600 });
  console.log(`${green("edited")} ${name} → ${target.path}`);
  return 0;
}

export async function subagentsDeleteCommand(ctx: CliContext, args: { name?: string; yes?: boolean }): Promise<number> {
  const name = (args.name ?? "").trim().toLowerCase();
  const target = (await discover(ctx)).find((s) => s.name === name);
  if (!target) {
    console.error(`${red("error:")} subagent "${name}" not found.`);
    return 1;
  }
  if (target.source === "built-in" || !target.path) {
    console.error(`${red("error:")} "${name}" is a built-in subagent and cannot be deleted.`);
    return 1;
  }
  if (!args.yes) {
    console.error(`${yellow("refusing:")} pass --yes to delete "${name}" (${target.path}).`);
    return 1;
  }
  try {
    rmSync(target.path, { force: true });
  } catch (err) {
    console.error(`${red("error:")} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.log(`${green("deleted")} ${name}`);
  return 0;
}

/** Shared one-shot runner for `subagent run|try`. */
async function runSubagentOnce(
  ctx: CliContext,
  args: { name?: string; task?: string; model?: string; "max-steps"?: string; yes?: boolean; dir?: string },
  forceReadonly: boolean,
): Promise<number> {
  const name = (args.name ?? "").trim().toLowerCase();
  const task = args.task?.trim();
  if (!name || !task) {
    console.error(`${red("error:")} usage: deyin subagent ${forceReadonly ? "try" : "run"} <name> "<task>" [--model REF] [--max-steps N] [--yes]`);
    return 1;
  }
  const target = (await discover(ctx)).find((s) => s.name === name);
  if (!target) {
    console.error(`${red("error:")} subagent "${name}" not found. Run \`deyin subagent list\` to see available ones.`);
    return 1;
  }
  const cwd = args.dir ? join(process.cwd(), args.dir) : ctx.cwd;
  const getToken = tokenSource(ctx);
  if ((await getToken()) === null) {
    console.error(`${red("error:")} not signed in. Run \`deyin login\` first.`);
    return 2;
  }
  const routing = { apiBaseUrl: ctx.config.apiBaseUrl, getToken };
  const def: SubagentDefinition = args["max-steps"] !== undefined && args["max-steps"] !== "" ? { ...target, maxSteps: Number(args["max-steps"]) } : target;
  const readonly = forceReadonly || def.readonly;
  const result = await runSubagent(def, task, {
    cwd,
    parent: { model: ctx.config.model, providerId: "openference", thinking: ctx.config.thinking },
    modelOverride: args.model?.trim() || ctx.config.subagentModels[name],
    effortOverride: undefined,
    maxStepsDefault: ctx.config.subagentMaxSteps,
    parentRouting: routing,
    resolveProvider: (providerId) => (providerId === "openference" ? routing : undefined),
    permissionEngine: new PermissionEngine({
      agentRules: [],
      configRules: [...ctx.config.permissions, ...subagentReadonlyRules({ readonly })],
      skipAll: Boolean(args.yes) && !readonly,
    }),
    resolvePermission: async () => "deny",
  });
  if (result.ok) {
    process.stdout.write(`${result.report}${result.report.endsWith("\n") ? "" : "\n"}`);
    return 0;
  }
  console.error(`${red("error:")} subagent "${name}" failed: ${result.report}`);
  if (result.report.includes("AuthRequired") || result.report.includes("not signed in")) return 2;
  return 1;
}

export function subagentsRunCommand(ctx: CliContext, args: Parameters<typeof runSubagentOnce>[1]): Promise<number> {
  return runSubagentOnce(ctx, args, false);
}

export function subagentsTryCommand(ctx: CliContext, args: Parameters<typeof runSubagentOnce>[1]): Promise<number> {
  return runSubagentOnce(ctx, args, true);
}
