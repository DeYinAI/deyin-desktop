import type { Client } from "ssh2";
import {
  BotError,
  ENGINE_DEFAULT_PORT,
  generateEngineToken,
  type BotRuntime,
  type DeyinBot,
  type EngineHostView,
  type EngineRegistration,
  type EngineSetupEvent,
  type EngineStatusView,
  type EngineSupervisor,
  type RuntimeHealth,
  type SshHostInfo,
} from "@deyin/host-core";
import { EngineLinks, type EngineLinksDeps } from "./links.js";
import { botRuntimeFor } from "./runtimes.js";
import { installEngine, uninstallEngine, type InstallOptions, type UninstallOptions } from "./installer.js";
import { sshShell } from "./ssh-shell.js";
import type { RemoteShell } from "./installer.js";
import type { EngineClient } from "./client.js";

/** What the service needs of the registry of engines. */
export interface ServiceRegistry {
  list(): EngineRegistration[];
  get(hostId: string): EngineRegistration | undefined;
  token(hostId: string): string | null;
  save(input: { hostId: string; port?: number; token: string; supervisor: EngineSupervisor; survivesReboot: boolean; version?: string }): EngineRegistration;
  setVersion(hostId: string, version: string): void;
  remove(hostId: string): boolean;
  onChange(listener: () => void): () => void;
}

export interface EngineServiceDeps {
  registry: ServiceRegistry;
  hosts: { list(): SshHostInfo[] };
  bots: { list(): DeyinBot[] };
  /** An SSH connection to a saved server, its host key already pinned; a refusal is thrown. */
  connect(hostId: string): Promise<Client>;
  /** A Bot's own files folder on this machine. */
  filesDir(botId: string): string;
  /** Told about setup as it happens, for the progress list. */
  emit(event: EngineSetupEvent): void;
  /** Setup and removal. Left out, the real ones; given in tests so they need no server. */
  installer?: {
    install(options: InstallOptions): ReturnType<typeof installEngine>;
    uninstall(options: UninstallOptions): ReturnType<typeof uninstallEngine>;
  };
  /** How an SSH connection becomes a shell. Left out, over ssh2. */
  shellOf?: (client: Client) => RemoteShell;
  /** The connections to the engines. Left out, made from `connect` and the registry. */
  links?: Pick<EngineLinks, "client" | "isConnected" | "close" | "closeAll">;
}

interface Busy {
  kind: "installing" | "removing";
  abort: AbortController;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Everything the app does with the Bot engines on a person's servers: set one up (and show how it is going), say
 * how it is, take it off, and hand out the runtime a Bot works through. One setup or removal runs on a server at a
 * time.
 */
export class BotEngineService {
  private readonly links: Pick<EngineLinks, "client" | "isConnected" | "close" | "closeAll">;
  private readonly busy = new Map<string, Busy>();
  private readonly listeners = new Set<() => void>();
  private readonly stopRegistry: () => void;

  constructor(private readonly deps: EngineServiceDeps) {
    const linkDeps: EngineLinksDeps = {
      connect: (hostId) => deps.connect(hostId),
      registry: deps.registry,
      labelOf: (hostId) => this.labelOf(hostId),
    };
    this.links = deps.links ?? new EngineLinks(linkDeps);
    this.stopRegistry = deps.registry.onChange(() => this.changed());
  }

  /** What the person is told a server is called. A server they have since removed is still named. */
  private labelOf(hostId: string): string {
    return this.deps.hosts.list().find((host) => host.id === hostId)?.label ?? "that server";
  }

  /** An SSH connection to a server, or a `BotError` that says in words why not. */
  private async connectTo(hostId: string): Promise<Client> {
    try {
      return await this.deps.connect(hostId);
    } catch (error) {
      if (error instanceof BotError) throw error;
      throw new BotError("conflict", `Could not connect to ${this.labelOf(hostId)}: ${describe(error)}`);
    }
  }

  private host(hostId: string): SshHostInfo {
    const found = this.deps.hosts.list().find((host) => host.id === hostId);
    if (!found) throw new BotError("not_found", "That server is not saved any more.");
    return found;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  list(): EngineHostView[] {
    const bots = this.deps.bots.list();
    return this.deps.hosts.list().map((host) => {
      const registration = this.deps.registry.get(host.id);
      const busy = this.busy.get(host.id);
      return {
        hostId: host.id,
        label: host.label,
        address: `${host.username}@${host.host}${host.port === 22 ? "" : `:${host.port}`}`,
        pinned: Boolean(host.knownHostFingerprint),
        ...(registration
          ? {
              engine: {
                port: registration.port,
                ...(registration.version ? { version: registration.version } : {}),
                supervisor: registration.supervisor,
                survivesReboot: registration.survivesReboot,
                installedAt: registration.installedAt,
                connected: this.links.isConnected(host.id),
              },
            }
          : {}),
        bots: bots.filter((bot) => bot.harness === "server" && bot.hostId === host.id).length,
        ...(busy ? { busy: busy.kind } : {}),
      };
    });
  }

  /** Ask a server's engine how it is. */
  async status(hostId: string, signal?: AbortSignal): Promise<EngineStatusView> {
    const client = await this.links.client(hostId);
    const status = await client.status(signal);
    this.deps.registry.setVersion(hostId, status.version);
    return {
      version: status.version,
      startedAt: status.startedAt,
      agentFound: status.agent.found,
      ...(status.agent.version ? { agentVersion: status.agent.version } : {}),
      signedIn: status.agent.signedIn,
      runningNow: status.runningNow,
      bots: status.bots,
    };
  }

  private claim(hostId: string, kind: Busy["kind"], label: string): Busy {
    if (this.busy.has(hostId)) throw new BotError("conflict", `Setup or removal is already running on ${label}.`);
    const claimed: Busy = { kind, abort: new AbortController() };
    this.busy.set(hostId, claimed);
    this.changed();
    return claimed;
  }

  private release(hostId: string, claimed: Busy): void {
    if (this.busy.get(hostId) === claimed) this.busy.delete(hostId);
    this.changed();
  }

  /**
   * Put the engine on a server, or bring one already there up to date and running. Progress and the sign-in the
   * server may ask for are reported through `emit`; the last report is always `finished`.
   */
  async install(hostId: string): Promise<{ version: string; warnings: string[] }> {
    const host = this.host(hostId);
    if (!host.knownHostFingerprint) {
      throw new BotError("invalid", `${host.label}'s host key is not pinned yet. Test the connection under Settings, Servers and accept the key first, so this app knows it is talking to the right machine.`);
    }
    const claimed = this.claim(hostId, "installing", host.label);
    let client: Client | undefined;
    try {
      client = await this.connectTo(hostId);
      const existing = this.deps.registry.get(hostId);
      const token = this.deps.registry.token(hostId) ?? generateEngineToken();
      const port = existing?.port ?? ENGINE_DEFAULT_PORT;
      const install = this.deps.installer?.install ?? installEngine;
      const result = await install({
        shell: (this.deps.shellOf ?? sshShell)(client),
        token,
        port,
        signal: claimed.abort.signal,
        onProgress: (progress) => this.deps.emit({ type: "step", hostId, step: progress.step, state: progress.state, message: progress.message }),
        onSignIn: (prompt) => this.deps.emit({ type: "sign-in", hostId, url: prompt.url, code: prompt.code }),
        register: (registration) => {
          this.deps.registry.save({ hostId, port: registration.port, token: registration.token, supervisor: registration.supervisor, survivesReboot: registration.survivesReboot });
          // A key or port that changed means any connection kept from before is talking to the wrong engine.
          this.links.close(hostId);
        },
        verify: async () => (await this.links.client(hostId)).status(claimed.abort.signal),
      });
      this.deps.registry.setVersion(hostId, result.version);
      this.deps.emit({ type: "finished", hostId, ok: true, version: result.version, warnings: result.warnings });
      return { version: result.version, warnings: result.warnings };
    } catch (error) {
      this.deps.emit({ type: "finished", hostId, ok: false, message: describe(error) });
      throw error;
    } finally {
      client?.end();
      this.release(hostId, claimed);
    }
  }

  /** Stop a setup or removal that is running on a server. */
  cancel(hostId: string): boolean {
    const running = this.busy.get(hostId);
    if (!running) return false;
    running.abort.abort();
    return true;
  }

  /** Take the engine off a server, and with `purge` the Bots' files and routines there too. */
  async uninstall(hostId: string, purge: boolean): Promise<void> {
    const host = this.host(hostId);
    if (!this.deps.registry.get(hostId)) throw new BotError("not_found", `There is no Bot engine on ${host.label}.`);
    const claimed = this.claim(hostId, "removing", host.label);
    let client: Client | undefined;
    try {
      client = await this.connectTo(hostId);
      const uninstall = this.deps.installer?.uninstall ?? uninstallEngine;
      await uninstall({ shell: (this.deps.shellOf ?? sshShell)(client), purge, signal: claimed.abort.signal });
      this.forget(hostId);
    } finally {
      client?.end();
      this.release(hostId, claimed);
    }
  }

  /**
   * Stop using a server's engine without reaching it: for when the server is gone, or was removed from the list.
   * The engine, if the server is still there, keeps running; nothing here can tell it to stop.
   */
  forget(hostId: string): boolean {
    this.links.close(hostId);
    return this.deps.registry.remove(hostId);
  }

  /** Forget the engines of servers that are no longer saved, e.g. removed while the app was closed. */
  prune(): number {
    const known = new Set(this.deps.hosts.list().map((host) => host.id));
    let removed = 0;
    for (const registration of this.deps.registry.list()) {
      if (known.has(registration.hostId)) continue;
      this.forget(registration.hostId);
      removed += 1;
    }
    return removed;
  }

  /** The engine on a server, connecting first if need be. Throws a `BotError` when there is none or it cannot be reached. */
  client(hostId: string): Promise<EngineClient> {
    return this.links.client(hostId);
  }

  /**
   * Forget a Bot that lived on a server: its files, routines and records there. Best effort and never throws: the Bot
   * is already gone here, and a server that cannot be reached keeps its copy until the engine is removed.
   */
  async removeBot(bot: Pick<DeyinBot, "id" | "harness" | "hostId">): Promise<boolean> {
    if (bot.harness !== "server" || !bot.hostId || !this.deps.registry.get(bot.hostId)) return false;
    try {
      return await (await this.links.client(bot.hostId)).removeBot(bot.id);
    } catch {
      return false;
    }
  }

  /** The computer a Bot works on. Throws a `BotError` when it has no usable server. */
  runtime(bot: DeyinBot): BotRuntime {
    return botRuntimeFor(bot, { filesDir: (botId) => this.deps.filesDir(botId), links: { client: (hostId): Promise<EngineClient> => this.links.client(hostId) } });
  }

  /** The name of the server a Bot lives on, for messages. */
  label(bot: DeyinBot): string {
    return bot.hostId ? this.labelOf(bot.hostId) : "its server";
  }

  /** Whether a Bot's computer can run it right now. A Bot with nowhere to run says so rather than throwing. */
  async health(bot: DeyinBot, signal?: AbortSignal): Promise<RuntimeHealth> {
    try {
      return await this.runtime(bot).health(signal);
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
  }

  dispose(): void {
    this.stopRegistry();
    for (const running of this.busy.values()) running.abort.abort();
    this.links.closeAll();
    this.listeners.clear();
  }
}
