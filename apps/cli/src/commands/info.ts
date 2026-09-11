import { resolveAgents } from "@deyin/agent-core";
import { listModels } from "@deyin/host-core";
import type { CliContext } from "../context.js";
import { tokenSource } from "../context.js";
import { cliMcpDefinitions, loadCliCapabilities } from "../capabilities.js";
import { bold, cyan, dim, green } from "../output.js";

export async function modelsCommand(ctx: CliContext): Promise<number> {
  const getToken = tokenSource(ctx);
  const signedIn = (await getToken()) !== null;
  const models = await listModels(ctx.config, getToken);
  if (!signedIn) console.log(dim("Not signed in: showing the default catalog. Run `deyin login` for your live model list.\n"));
  for (const m of models) {
    const marks: string[] = [];
    if (m.id === ctx.config.model) marks.push(green("default"));
    if (m.contextLength) marks.push(dim(`${Math.round(m.contextLength / 1000)}k ctx`));
    console.log(`${bold(m.id.padEnd(28))} ${marks.join("  ")}`);
  }
  console.log(dim(`\nSwitch with \`deyin -m <model>\`, /model in the TUI, or "model" in ~/.deyin/config.json.`));
  return 0;
}

export async function agentsCommand(ctx: CliContext): Promise<number> {
  for (const agent of resolveAgents(ctx.config)) {
    const marks: string[] = [];
    if (agent.name === ctx.config.agent) marks.push(green("default"));
    if (agent.model) marks.push(dim(`model: ${agent.model}`));
    if (agent.permissions?.length) marks.push(dim(`${agent.permissions.length} permission rule(s)`));
    console.log(`${bold(agent.name.padEnd(12))} ${agent.description} ${marks.join("  ")}`);
  }
  console.log(dim(`\nSwitch with \`deyin -a <agent>\`, /agent in the TUI, or define custom agents in deyin.json.`));
  return 0;
}

export async function usageCommand(ctx: CliContext): Promise<number> {
  const stats = ctx.usage.stats();
  console.log(`${bold("Total tokens")}   ${stats.totalTokens.toLocaleString()}`);
  console.log(`${bold("Messages")}       ${stats.messages.toLocaleString()}`);
  console.log(`${bold("Sessions")}       ${stats.sessions.toLocaleString()}`);
  console.log(`${bold("Active days")}    ${stats.activeDays} (streak: ${stats.currentStreak})`);
  if (stats.favoriteModel) {
    console.log(`${bold("Favorite model")} ${stats.favoriteModel.id} (${stats.favoriteModel.share}%)`);
  }
  const recent = stats.days.slice(-7);
  if (recent.length > 0) {
    console.log(`\n${dim("Last days:")}`);
    for (const day of recent) {
      const tokens = Object.values(day.byModel).reduce((a, b) => a + b, 0);
      console.log(dim(`  ${day.date}  ${String(tokens).padStart(10)} tokens  ${day.messages} messages`));
    }
  }
  return 0;
}

export async function sessionsCommand(ctx: CliContext): Promise<number> {
  const sessions = ctx.sessions.list();
  if (sessions.length === 0) {
    console.log("No sessions yet. Start one with `deyin`.");
    return 0;
  }
  for (const s of sessions.slice(0, 30)) {
    const when = s.updatedAt.slice(0, 16).replace("T", " ");
    console.log(`${cyan(s.id)}  ${dim(when)}  ${s.title.slice(0, 60)}  ${dim(s.cwd)}`);
  }
  console.log(dim("\nResume with `deyin resume <id>` or continue the latest with `deyin -c`."));
  return 0;
}

export async function memoryCommand(ctx: CliContext, query?: string): Promise<number> {
  const q = query?.trim();
  const facts = q ? ctx.memory.search(q).map((h) => h.fact) : ctx.memory.list();
  if (facts.length === 0) {
    console.log(q ? `No relevant memories for "${q}".` : "No saved memories. The agent can save them with its remember tool.");
    return 0;
  }
  for (const f of facts) {
    const marks: string[] = [dim(`${f.type} \u00b7 ${f.scope}`), dim(`rev ${f.revision}`)];
    if (f.updatedAt !== f.createdAt) marks.push(dim(`updated ${f.updatedAt.slice(0, 10)}`));
    console.log(`${bold(f.scope + "/" + f.name).padEnd(36)} ${f.title} ${marks.join("  ")}`);
    if (f.description) console.log(dim(`  ${f.description}`));
  }
  console.log(dim(`\n${facts.length} fact(s)${q ? ` for "${q}"` : ""}. Forget with the agent's forget tool or delete the file under ${ctx.dataDir}/memory.`));
  return 0;
}

/** Show every capability source the CLI can load for the current workspace. */
export async function capabilitiesCommand(ctx: CliContext, trustWorkspace = false): Promise<number> {
  const caps = await loadCliCapabilities({ cwd: ctx.cwd, dataDir: ctx.dataDir, trustedWorkspace: trustWorkspace });
  const rows: Array<[string, string, string]> = [];
  for (const plugin of caps.plugins) rows.push(["plugin", plugin.name, plugin.source]);
  for (const skill of caps.skills) rows.push(["skill", skill.name, skill.source]);
  for (const command of caps.commands) rows.push(["command", `/${command.name}`, command.source]);
  for (const subagent of caps.subagents) rows.push(["subagent", subagent.name, subagent.source]);
  for (const hook of caps.hooks) rows.push(["hook", hook.event, hook.source]);
  for (const server of caps.mcpServers) rows.push(["mcp", server.name, `${server.source} (${server.transport})`]);
  if (rows.length === 0) {
    console.log("No capabilities discovered for this workspace.");
    return 0;
  }
  for (const [kind, name, source] of rows) console.log(`${bold(kind.padEnd(9))} ${name.padEnd(24)} ${dim(source)}`);
  console.log(dim(`\n${rows.length} capability(s). Workspace hooks/MCP require --trust when sourced from this repository.`));
  return 0;
}

/** List effective MCP definitions without starting their processes. */
export async function mcpListCommand(ctx: CliContext, trustWorkspace = false): Promise<number> {
  const caps = await loadCliCapabilities({ cwd: ctx.cwd, dataDir: ctx.dataDir, trustedWorkspace: trustWorkspace });
  const defs = cliMcpDefinitions(caps, ctx.config.mcpServers);
  if (defs.length === 0) {
    console.log("No MCP servers configured.");
    return 0;
  }
  for (const server of defs) {
    const endpoint = server.transport === "stdio" ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ") : server.url;
    const status = server.enabled ? green("enabled") : dim("disabled");
    console.log(`${bold(server.name.padEnd(20))} ${status}  ${server.transport.padEnd(6)}  ${endpoint ?? ""}  ${dim(server.source)}`);
  }
  console.log(dim(`\n${defs.length} server(s). Start a run with deyin run; use --trust for workspace-owned definitions.`));
  return 0;
}
