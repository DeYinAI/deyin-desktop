import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { ENGINE_DEFAULT_PORT, ENGINE_HOME, ENGINE_PATHS, isEngineHealth, type EngineStatus } from "@deyin/host-core";
import { resolveDeyinCommand, type DeyinCommand } from "./agent-run.js";
import { BotEngine, type BotEngineOptions } from "./engine.js";
import { createEngineServer } from "./server.js";
import { EngineStore } from "./store.js";

export { resolveDeyinCommand, type DeyinCommand } from "./agent-run.js";
export { BotEngine } from "./engine.js";

export const ENGINE_HOST = "127.0.0.1";

export interface StartEngineOptions {
  /** The version the engine reports: the `deyin` build that carries it. */
  version: string;
  /** The engine's folder; `~/.deyin-bot` by default. */
  home?: string;
  /** 0 picks a free port. */
  port?: number;
  tokenFile?: string;
  /** The `deyin` the engine runs agents with. */
  deyin?: string | DeyinCommand;
  /** Passed to the engine; for tests. */
  engine?: Partial<Pick<BotEngineOptions, "jobFactory" | "spawnImpl" | "env" | "now" | "probeTtlMs" | "maxConcurrentRuns">>;
}

export interface RunningEngine {
  engine: BotEngine;
  server: Server;
  port: number;
  home: string;
  close(): Promise<void>;
}

export function defaultEngineHome(): string {
  return join(homedir(), ENGINE_HOME);
}

/**
 * Read the engine's key. It must be there, long enough to be a key and readable by its owner alone: a key anyone on
 * the server can read lets anyone on the server run commands as the person who owns it, so the engine will not start
 * with one.
 */
export function readEngineToken(file: string): string {
  if (!existsSync(file)) throw new Error(`There is no key at ${file}. Install the engine from the Deyin desktop app to create one.`);
  if (process.platform !== "win32") {
    const mode = statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(`The key at ${file} can be read by other users (mode ${mode.toString(8)}). Run: chmod 600 ${file}`);
    }
  }
  const token = readFileSync(file, "utf8").trim();
  if (token.length < 32) throw new Error(`The key at ${file} is too short to be a key.`);
  return token;
}

/** Start the engine on the server's loopback, and give back what is needed to stop it. */
export async function startBotEngine(options: StartEngineOptions): Promise<RunningEngine> {
  const home = options.home ?? defaultEngineHome();
  const store = new EngineStore(home);
  store.ensure();
  try {
    chmodSync(home, 0o700);
  } catch {
    // Not ours to change (a shared folder); the key check is what matters.
  }
  const token = readEngineToken(options.tokenFile ?? store.tokenFile());
  const deyin =
    typeof options.deyin === "object" ? options.deyin : resolveDeyinCommand({ ...(options.deyin ? { override: options.deyin } : {}), env: process.env });
  const engine = new BotEngine({ store, deyin, version: options.version, ...options.engine });
  const server = createEngineServer({ engine, token, version: options.version });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // The loopback only. The desktop reaches it through an SSH forward, so nothing else on the network can.
    server.listen(options.port ?? ENGINE_DEFAULT_PORT, ENGINE_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  engine.start();
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    engine,
    server,
    port,
    home,
    close: () => {
      closing ??= (async () => {
        await engine.stop();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return closing;
    },
  };
}

/** Run until told to stop, for `deyin bot-engine serve`. */
export async function serveBotEngine(options: StartEngineOptions): Promise<number> {
  let running: RunningEngine;
  try {
    running = await startBotEngine(options);
  } catch (error) {
    console.error(`deyin bot-engine: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.error(`deyin bot-engine ${options.version} listening on http://${ENGINE_HOST}:${running.port} (home ${running.home})`);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void running.close().then(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

/** Ask a running engine how it is, for `deyin bot-engine status`. */
export async function engineStatus(options: { home?: string; port?: number; tokenFile?: string } = {}): Promise<{ ok: true; status: EngineStatus } | { ok: false; error: string }> {
  const home = options.home ?? defaultEngineHome();
  const base = `http://${ENGINE_HOST}:${options.port ?? ENGINE_DEFAULT_PORT}`;
  let token: string;
  try {
    token = readEngineToken(options.tokenFile ?? new EngineStore(home).tokenFile());
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const health = await fetch(`${base}${ENGINE_PATHS.health}`, { signal: AbortSignal.timeout(5_000) });
    if (!isEngineHealth(await health.json().catch(() => null))) return { ok: false, error: `Something is on ${base}, but it is not a Bot engine.` };
    const res = await fetch(`${base}${ENGINE_PATHS.status}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) return { ok: false, error: "The engine did not accept the key in the key file." };
    if (!res.ok) return { ok: false, error: `The engine answered with status ${res.status}.` };
    return { ok: true, status: (await res.json()) as EngineStatus };
  } catch {
    return { ok: false, error: `The engine is not running on ${base}.` };
  }
}
