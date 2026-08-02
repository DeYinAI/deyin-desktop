import { resolveAgents } from "@deyin/agent-core";
import { listModels } from "@deyin/host-core";
import type { CliContext } from "../context.js";
import { tokenSource } from "../context.js";
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
