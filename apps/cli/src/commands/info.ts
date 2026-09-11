import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { resolveAgents } from "@deyin/agent-core";
import { CheckpointStore, checkpointFileOpsFromRoot, listModels, revertCheckpoint } from "@deyin/host-core";
import type { CliContext } from "../context.js";
import { cliProviderRouting, tokenSource } from "../context.js";
import { cliMcpDefinitions, loadCliCapabilities } from "../capabilities.js";
import { bold, cyan, dim, green } from "../output.js";

export async function modelsCommand(ctx: CliContext, providerId?: string, refresh = false, verbose = false): Promise<number> {
  const id = providerId?.trim() || ctx.config.providerId;
  const route = cliProviderRouting(ctx, id);
  if (refresh && route.provider?.kind === "custom") {
    const result = await ctx.agents.fetchModels(id);
    if (!result.ok) {
      console.error(`could not refresh models: ${result.message ?? `HTTP ${result.status ?? "error"}`}`);
      return 1;
    }
  }
  const signedIn = (await route.getToken()) !== null || route.provider?.local === true;
  const models = await listModels({ apiBaseUrl: route.apiBaseUrl }, route.getToken);
  if (!signedIn) console.log(dim("Not signed in: showing the default catalog. Run `deyin login` for your live model list.\n"));
  for (const m of models) {
    const marks: string[] = [];
    if (m.id === ctx.config.model || `${id}::${m.id}` === ctx.config.model) marks.push(green("default"));
    if (m.contextLength) marks.push(dim(`${Math.round(m.contextLength / 1000)}k ctx`));
    console.log(`${bold(m.id.padEnd(28))} ${marks.join("  ")}${verbose ? `  ${dim(JSON.stringify(m))}` : ""}`);
  }
  console.log(dim(`\nProvider: ${id}. Switch with \`deyin -m ${id}::<model>\`, /model in the TUI, or "providerId" + "model" in ~/.deyin/config.json.`));
  return 0;
}

/** List the same provider registry exposed by the desktop Identity page. */
export async function providersCommand(ctx: CliContext, format?: string): Promise<number> {
  const primaryToken = tokenSource(ctx);
  const connected = (await primaryToken()) !== null;
  const providers = ctx.agents.listProviders(connected).map((provider) => ({
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    status: provider.status,
    enabled: provider.enabled,
    baseUrl: provider.baseUrl,
    apiFormat: provider.apiFormat,
    hasKey: provider.hasKey,
    local: provider.local === true,
    modelCount: provider.models.length,
  }));
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(providers)}\n`);
    return 0;
  }
  for (const provider of providers) {
    const state = provider.status === "connected" || provider.local ? green("connected") : dim("not-connected");
    const key = provider.kind === "primary" ? "oauth" : provider.local ? "local" : provider.hasKey ? "key" : "no-key";
    console.log(`${bold(provider.id.padEnd(14))} ${provider.name.padEnd(18)} ${state}  ${key.padEnd(8)} ${provider.apiFormat}`);
  }
  console.log(dim("\nUse `deyin provider connect <id> --key <secret>` or `DEYIN_API_KEY` for custom providers."));
  return 0;
}

export async function providerAddCommand(ctx: CliContext, name?: string, baseUrl?: string): Promise<number> {
  if (!name?.trim() || !baseUrl?.trim()) {
    console.error("usage: deyin provider add <name> --url <https://endpoint/v1>");
    return 1;
  }
  const before = ctx.agents.listProviders(true).length;
  ctx.agents.addProvider({ name: name.trim(), baseUrl: baseUrl.trim() });
  const added = ctx.agents.listProviders(true).find((provider) => provider.name.toLowerCase() === name.trim().toLowerCase());
  if (!added || ctx.agents.listProviders(true).length === before) {
    console.error(`could not add provider "${name.trim()}" (duplicate or invalid URL)`);
    return 1;
  }
  console.log(`${added.id} -> ${added.baseUrl}`);
  return 0;
}

export async function providerConnectCommand(ctx: CliContext, id?: string, key?: string): Promise<number> {
  const providerId = id?.trim();
  const provider = providerId ? ctx.agents.listProviders(true).find((entry) => entry.id === providerId) : undefined;
  if (!provider) {
    console.error(`provider not found: ${providerId ?? ""}`.trim());
    return 1;
  }
  if (provider.kind === "primary") {
    console.error("Openference uses `deyin login`; provider keys are only for custom providers.");
    return 1;
  }
  const secret = key?.trim() || process.env.DEYIN_API_KEY?.trim();
  if (!secret && !provider.local) {
    console.error("missing key; pass --key or set DEYIN_API_KEY (it is never printed)");
    return 1;
  }
  ctx.agents.setKey(provider.id, provider.local ? "" : secret ?? "");
  console.log(`${provider.id} connected${provider.local ? " (keyless local endpoint)" : ""}`);
  return 0;
}

export async function providerRemoveCommand(ctx: CliContext, id?: string, confirmed = false): Promise<number> {
  const providerId = id?.trim();
  if (!providerId) {
    console.error("usage: deyin provider remove <id> --yes");
    return 1;
  }
  if (!confirmed) {
    console.error("refusing to remove without --yes");
    return 1;
  }
  const provider = ctx.agents.listProviders(true).find((entry) => entry.id === providerId);
  if (!provider) {
    console.error(`provider not found: ${providerId}`);
    return 1;
  }
  if (provider.kind === "primary") {
    console.error("cannot remove the primary Openference provider");
    return 1;
  }
  ctx.agents.removeProvider(providerId);
  console.log(`removed ${providerId}`);
  return 0;
}

export async function providerModelsCommand(ctx: CliContext, id?: string): Promise<number> {
  const providerId = id?.trim();
  if (!providerId) {
    console.error("usage: deyin provider models <id>");
    return 1;
  }
  const provider = ctx.agents.listProviders(true).find((entry) => entry.id === providerId);
  if (!provider) {
    console.error(`provider not found: ${providerId}`);
    return 1;
  }
  const result = await ctx.agents.fetchModels(providerId);
  if (!result.ok) {
    console.error(`could not fetch models: ${result.message ?? `HTTP ${result.status ?? "error"}`}`);
    return 1;
  }
  console.log(`${providerId}: ${result.modelCount ?? 0} model(s) fetched`);
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

export async function sessionsCommand(ctx: CliContext, opts: { maxCount?: number; format?: string } = {}): Promise<number> {
  const all = ctx.sessions.list();
  const maxCount = opts.maxCount === undefined ? 30 : Math.min(Math.max(Math.floor(opts.maxCount), 1), 500);
  const sessions = all.slice(0, maxCount);
  if (opts.format === "json") {
    process.stdout.write(`${JSON.stringify(sessions)}\n`);
    return 0;
  }
  if (sessions.length === 0) {
    console.log("No sessions yet. Start one with `deyin`.");
    return 0;
  }
  for (const s of sessions) {
    const when = s.updatedAt.slice(0, 16).replace("T", " ");
    console.log(`${cyan(s.id)}  ${dim(when)}  ${s.title.slice(0, 60)}  ${dim(s.cwd)}`);
  }
  console.log(dim("\nResume with `deyin resume <id>` or continue the latest with `deyin -c`."));
  return 0;
}

/** Export one session as a portable JSON snapshot. */
export async function exportSessionCommand(ctx: CliContext, id?: string, outputPath?: string): Promise<number> {
  const sessionId = id?.trim() || ctx.sessions.latest(ctx.cwd)?.id;
  if (!sessionId) {
    console.error("no session found; pass a session id or start a session first");
    return 1;
  }
  const snapshot = ctx.sessions.exportSnapshot(sessionId);
  if (!snapshot) {
    console.error(`session not found: ${sessionId}`);
    return 1;
  }
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (outputPath?.trim()) {
    const target = resolve(ctx.cwd, outputPath);
    writeFileSync(target, json, { encoding: "utf8", mode: 0o600 });
    console.log(target);
  } else {
    process.stdout.write(json);
  }
  return 0;
}

/** Import a portable session snapshot into the current workspace. */
export async function importSessionCommand(ctx: CliContext, inputPath?: string): Promise<number> {
  if (!inputPath?.trim()) {
    console.error("usage: deyin import <session.json>");
    return 1;
  }
  try {
    const snapshot = JSON.parse(readFileSync(resolve(ctx.cwd, inputPath), "utf8")) as unknown;
    const imported = ctx.sessions.importSnapshot(snapshot, { cwd: ctx.cwd });
    if (!imported) {
      console.error("invalid DeYin session export");
      return 1;
    }
    console.log(imported.id);
    return 0;
  } catch (err) {
    console.error(`could not import session: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Delete one saved session, requiring an explicit confirmation flag. */
export async function deleteSessionCommand(ctx: CliContext, id?: string, confirmed = false): Promise<number> {
  const sessionId = id?.trim();
  if (!sessionId) {
    console.error("usage: deyin session delete <session-id> --yes");
    return 1;
  }
  if (!confirmed) {
    console.error("refusing to delete without --yes");
    return 1;
  }
  if (!ctx.sessions.remove(sessionId)) {
    console.error(`session not found: ${sessionId}`);
    return 1;
  }
  console.log(`deleted ${sessionId}`);
  return 0;
}

/** Create a new session log from an existing transcript prefix. */
export async function forkSessionCommand(ctx: CliContext, id?: string, atSeq?: string): Promise<number> {
  const sourceId = id?.trim();
  if (!sourceId) {
    console.error("usage: deyin fork <session-id> [--at-seq <n>]");
    return 1;
  }
  const parsedSeq = atSeq === undefined || atSeq.trim() === "" ? undefined : Number(atSeq);
  if (parsedSeq !== undefined && (!Number.isInteger(parsedSeq) || parsedSeq < 0)) {
    console.error("--at-seq must be a non-negative integer");
    return 1;
  }
  const forked = ctx.sessions.fork(sourceId, parsedSeq === undefined ? undefined : { atSeq: parsedSeq });
  if (!forked) {
    console.error(`session not found: ${sourceId}`);
    return 1;
  }
  console.log(forked.id);
  console.log(dim(`Forked ${sourceId} into a new session. Resume with "deyin resume ${forked.id}".`));
  return 0;
}

function resolveCheckpointPath(cwd: string, path: string): string {
  const root = resolve(cwd);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path escapes workspace: ${path}`);
  return absolute;
}

function checkpointSessionId(ctx: CliContext, id?: string): string | undefined {
  return id?.trim() || ctx.sessions.latest(ctx.cwd)?.id;
}

/** List durable file-mutation checkpoints recorded by agent runs. */
export async function checkpointListCommand(
  ctx: CliContext,
  id?: string,
  format?: string,
): Promise<number> {
  const sessionId = checkpointSessionId(ctx, id);
  if (!sessionId) {
    console.error("no session found; pass a session id or start a session first");
    return 1;
  }
  const entries = new CheckpointStore(ctx.storage).list(sessionId);
  const groups = new Map<string, { checkpointId: string; entries: typeof entries }>();
  for (const entry of entries) {
    const group = groups.get(entry.checkpointId) ?? { checkpointId: entry.checkpointId, entries: [] };
    group.entries.push(entry);
    groups.set(entry.checkpointId, group);
  }
  const checkpoints = [...groups.values()].map((group) => ({
    checkpointId: group.checkpointId,
    active: group.entries.filter((entry) => entry.revertedAt === undefined).length,
    reverted: group.entries.filter((entry) => entry.revertedAt !== undefined).length,
    paths: [...new Set(group.entries.map((entry) => entry.path))],
    appliedAt: Math.min(...group.entries.map((entry) => entry.appliedAt)),
  }));
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ sessionId, checkpoints })}\n`);
    return 0;
  }
  if (checkpoints.length === 0) {
    console.log(`No checkpoints for session ${sessionId}.`);
    return 0;
  }
  console.log(`${bold("Session")} ${cyan(sessionId)}`);
  for (const checkpoint of checkpoints) {
    const when = new Date(checkpoint.appliedAt).toISOString().slice(0, 19).replace("T", " ");
    console.log(`${cyan(checkpoint.checkpointId)}  ${dim(when)}  ${checkpoint.active} active  ${checkpoint.paths.length} path(s)`);
    for (const path of checkpoint.paths) console.log(dim(`  ${path}`));
  }
  console.log(dim("\nRevert with `deyin checkpoint revert <session-id> <checkpoint-id> --yes`."));
  return 0;
}

/** Revert all active file changes from one agent run. */
export async function checkpointRevertCommand(
  ctx: CliContext,
  id: string | undefined,
  checkpointId: string | undefined,
  confirmed: boolean,
  paths?: string,
): Promise<number> {
  const sessionId = checkpointSessionId(ctx, id);
  if (!sessionId || !checkpointId?.trim()) {
    console.error("usage: deyin checkpoint revert <session-id> <checkpoint-id> --yes [--path file,...]");
    return 1;
  }
  if (!confirmed) {
    console.error("refusing to revert without --yes");
    return 1;
  }
  try {
    const store = new CheckpointStore(ctx.storage);
    const ops = checkpointFileOpsFromRoot(ctx.cwd, async (path) => resolveCheckpointPath(ctx.cwd, path));
    const result = await revertCheckpoint(
      store,
      ctx.storage,
      ops,
      sessionId,
      checkpointId.trim(),
      undefined,
      paths?.trim()
        ? {
            paths: paths
              .split(",")
              .map((path) => path.trim())
              .filter(Boolean)
              .map((path) => resolveCheckpointPath(ctx.cwd, path)),
          }
        : undefined,
    );
    if (!result.ok) {
      console.error(`revert failed: ${result.error ?? "unknown error"}`);
      return 1;
    }
    console.log(`reverted ${result.revertedPaths.length} path(s) from ${checkpointId.trim()}`);
    for (const path of result.revertedPaths) console.log(dim(`  ${path}`));
    return 0;
  } catch (err) {
    console.error(`could not revert checkpoint: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
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

/** Add a stdio or remote MCP definition to the user or workspace config. */
export async function mcpAddCommand(
  ctx: CliContext,
  input: { name?: string; command?: string; args?: string; url?: string; type?: string; global?: boolean },
): Promise<number> {
  const name = input.name?.trim();
  const command = input.command?.trim();
  const url = input.url?.trim();
  if (!name || (!command && !url) || (command && url)) {
    console.error("usage: deyin mcp add <name> (--command <program> [--args a,b] | --url <endpoint> [--type sse|http])");
    return 1;
  }
  const target = input.global ? resolve(ctx.dataDir, "mcp.json") : resolve(ctx.cwd, ".deyin", "mcp.json");
  let config: { mcpServers?: Record<string, Record<string, unknown>> } = {};
  try {
    config = JSON.parse(readFileSync(target, "utf8")) as typeof config;
  } catch {
    // A missing or invalid file is replaced only after the new definition is validated.
  }
  const server: Record<string, unknown> = {};
  if (command) {
    server.command = command;
    if (input.args?.trim()) server.args = input.args.split(",").map((arg) => arg.trim()).filter(Boolean);
  } else {
    server.url = url;
    if (input.type === "sse" || input.type === "http") server.type = input.type;
  }
  config.mcpServers = { ...(config.mcpServers ?? {}), [name]: server };
  mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`${name} -> ${target}`);
  return 0;
}
