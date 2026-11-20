import {
  BotError,
  ENGINE_HOME,
  ExecCollector,
  RUNTIME_LIMITS,
  cleanRelativePath,
  ensureBotRoot,
  listBotFiles,
  readBotFile,
  removeBotFile,
  runtimeCapabilities,
  streamBotCommand,
  writeBotFile,
  type BotRuntime,
  type DeyinBot,
  type RuntimeExecRequest,
  type RuntimeExecResult,
  type RuntimeFileEntry,
  type RuntimeHealth,
  type RuntimeRunRequest,
  type RuntimeRunResult,
} from "@deyin/host-core";
import type { EngineClient } from "./client.js";

/** Runs the agent as a Bot on this machine, for a caller that wires the app's own agent in. */
export type LocalAgentRunner = (request: RuntimeRunRequest, onEvent: (line: string) => void, signal?: AbortSignal) => Promise<RuntimeRunResult>;

export interface LocalRuntimeOptions {
  /** The Bot's own files folder on this machine. */
  root: string;
  runAgent?: LocalAgentRunner;
}

/** A Bot whose computer is this one: its files folder, and commands run in it. */
export class LocalBotRuntime implements BotRuntime {
  readonly kind = "local" as const;
  readonly capabilities = runtimeCapabilities("local");
  readonly home: string;

  constructor(private readonly options: LocalRuntimeOptions) {
    this.home = options.root;
  }

  async health(): Promise<RuntimeHealth> {
    try {
      await ensureBotRoot(this.options.root);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `This Bot's folder cannot be used: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async exec(request: RuntimeExecRequest, signal?: AbortSignal): Promise<RuntimeExecResult> {
    const root = await ensureBotRoot(this.options.root);
    const collector = new ExecCollector(RUNTIME_LIMITS.outputBytes);
    await streamBotCommand(root, request, (line) => collector.add(line), { signal });
    return collector.finish() ?? collector.partial();
  }

  async listFiles(path: string): Promise<RuntimeFileEntry[]> {
    return listBotFiles(await ensureBotRoot(this.options.root), cleanRelativePath(path, { allowRoot: true }));
  }

  async readFile(path: string): Promise<string> {
    return readBotFile(await ensureBotRoot(this.options.root), cleanRelativePath(path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    await writeBotFile(await ensureBotRoot(this.options.root), cleanRelativePath(path), content);
  }

  async removeFile(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await removeBotFile(await ensureBotRoot(this.options.root), cleanRelativePath(path), options);
  }

  async run(request: RuntimeRunRequest, onEvent: (line: string) => void, signal?: AbortSignal): Promise<RuntimeRunResult> {
    if (!this.options.runAgent) throw new BotError("invalid", "A Bot on this computer runs in the app itself, not through this call.");
    return this.options.runAgent(request, onEvent, signal);
  }
}

export interface ServerRuntimeOptions {
  botId: string;
  hostId: string;
  links: { client(hostId: string): Promise<EngineClient> };
}

/** A Bot whose computer is a server the person owns, reached through the engine installed there. */
export class ServerBotRuntime implements BotRuntime {
  readonly kind = "server" as const;
  readonly capabilities = runtimeCapabilities("server");
  readonly home: string;

  constructor(private readonly options: ServerRuntimeOptions) {
    this.home = `~/${ENGINE_HOME}/bots/${options.botId}/files`;
  }

  private client(): Promise<EngineClient> {
    return this.options.links.client(this.options.hostId);
  }

  async health(signal?: AbortSignal): Promise<RuntimeHealth> {
    try {
      const client = await this.client();
      const health = await client.health(signal);
      const status = await client.status(signal);
      if (!status.agent.found) return { ok: false, version: health.version, reason: "The engine could not find deyin on the server to run this Bot with." };
      if (!status.agent.signedIn) return { ok: false, version: health.version, reason: "deyin on the server is not signed in. Open Settings, Servers and set the engine up again." };
      return { ok: true, version: health.version };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async exec(request: RuntimeExecRequest, signal?: AbortSignal): Promise<RuntimeExecResult> {
    return (await this.client()).exec(this.options.botId, request, signal);
  }

  // A path is checked before the server is reached, so a bad one costs no connection and the server never sees it.
  async listFiles(path: string, signal?: AbortSignal): Promise<RuntimeFileEntry[]> {
    const clean = cleanRelativePath(path, { allowRoot: true });
    return (await this.client()).listFiles(this.options.botId, clean, signal);
  }

  async readFile(path: string, signal?: AbortSignal): Promise<string> {
    const clean = cleanRelativePath(path);
    return (await this.client()).readFile(this.options.botId, clean, signal);
  }

  async writeFile(path: string, content: string, signal?: AbortSignal): Promise<void> {
    const clean = cleanRelativePath(path);
    await (await this.client()).writeFile(this.options.botId, clean, content, signal);
  }

  async removeFile(path: string, options: { recursive?: boolean } = {}, signal?: AbortSignal): Promise<void> {
    const clean = cleanRelativePath(path);
    await (await this.client()).removeFile(this.options.botId, clean, options.recursive === true, signal);
  }

  async run(request: RuntimeRunRequest, onEvent: (line: string) => void, signal?: AbortSignal): Promise<RuntimeRunResult> {
    const outcome = await (await this.client()).run(this.options.botId, request, onEvent, signal);
    return { reason: outcome.reason, finalText: outcome.finalText, ...(outcome.error ? { error: outcome.error } : {}) };
  }
}

export interface BotRuntimeSource {
  /** The Bot's own files folder on this machine. */
  filesDir(botId: string): string;
  links: { client(hostId: string): Promise<EngineClient> };
  runLocalAgent?: LocalAgentRunner;
}

/** The computer a Bot works on, as the Bot says: this one, or the server it lives on. */
export function botRuntimeFor(bot: Pick<DeyinBot, "id" | "name" | "harness" | "hostId">, source: BotRuntimeSource): BotRuntime {
  switch (bot.harness) {
    case "local":
      return new LocalBotRuntime({ root: source.filesDir(bot.id), ...(source.runLocalAgent ? { runAgent: source.runLocalAgent } : {}) });
    case "server":
      if (!bot.hostId) throw new BotError("invalid", `${bot.name} is set to run on a server, but no server is chosen. Pick one in the Bot's settings.`);
      return new ServerBotRuntime({ botId: bot.id, hostId: bot.hostId, links: source.links });
    default: {
      const unhandled: never = bot.harness;
      throw new Error(`Unhandled harness: ${String(unhandled)}`);
    }
  }
}
