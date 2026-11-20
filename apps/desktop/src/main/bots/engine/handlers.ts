import {
  BotError,
  botResult,
  botResultAsync,
  type BotResult,
  type DeyinBot,
  type EngineHostView,
  type EngineStatusView,
  type RuntimeHealth,
} from "@deyin/host-core";
import type { BotEngineService } from "./service.js";

export interface EngineHandlerDeps {
  service: Pick<BotEngineService, "list" | "status" | "install" | "cancel" | "uninstall" | "forget" | "health">;
  bots: { get(id: string): DeyinBot | undefined };
}

export interface EngineHandlers {
  list(): EngineHostView[];
  status(hostId: unknown): Promise<BotResult<EngineStatusView>>;
  install(hostId: unknown): Promise<BotResult<{ version: string; warnings: string[] }>>;
  cancel(hostId: unknown): boolean;
  uninstall(hostId: unknown, purge: unknown): Promise<BotResult<null>>;
  forget(hostId: unknown): BotResult<null>;
  health(botId: unknown): Promise<BotResult<RuntimeHealth>>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new BotError("invalid", `${what} is required.`);
  return value;
}

/**
 * The IPC handlers for the Bot engines over the service. Everything arrives from the renderer, so it is checked
 * here and a refusal comes back as text, never thrown across the IPC boundary. Nothing returned holds the engine's
 * key or the sign-in the server printed: those stay in the main process, or in an event the Servers page shows.
 */
export function createEngineHandlers(deps: EngineHandlerDeps): EngineHandlers {
  return {
    list: () => deps.service.list(),
    status: (hostId) => botResultAsync(() => deps.service.status(text(hostId, "The server"))),
    install: (hostId) => botResultAsync(() => deps.service.install(text(hostId, "The server"))),
    cancel: (hostId) => typeof hostId === "string" && hostId !== "" && deps.service.cancel(hostId),
    uninstall: (hostId, purge) =>
      botResultAsync(async () => {
        if (typeof purge !== "boolean") throw new BotError("invalid", "Say whether to delete the Bots' files on the server too.");
        await deps.service.uninstall(text(hostId, "The server"), purge);
        return null;
      }),
    forget: (hostId) =>
      botResult(() => {
        if (!deps.service.forget(text(hostId, "The server"))) throw new BotError("not_found", "There is no Bot engine here to forget.");
        return null;
      }),
    health: (botId) =>
      botResultAsync(async () => {
        const bot = deps.bots.get(text(botId, "The Bot"));
        if (!bot) throw new BotError("not_found", "That Bot no longer exists.");
        return deps.service.health(bot);
      }),
  };
}
