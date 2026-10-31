import { join } from "node:path";
import { BrowserWindow, ipcMain, safeStorage } from "electron";
import { createBuiltinRegistry } from "@deyin/agent-core";
import { CH, type SuperagentReply } from "@deyin/contract";
import type { FetchLike, Logger } from "@deyin/superagent";
import { resolveProviderRouting, type AgentRunContextDeps } from "../automations/agent-run-context.js";
import { parseModelId } from "./runner.js";
import { SuperagentService } from "./service.js";
import { createCipher } from "./token-store.js";

export interface SuperagentRegistration {
  /** Stops every run and writes everything down. */
  dispose(): Promise<void>;
}

const logger: Logger = {
  info: (message) => console.log(`[superagent] ${message}`),
  warn: (message) => console.warn(`[superagent] ${message}`),
};

const fetchNow: FetchLike = (url, init) => fetch(url, init);

const invalid = (what: string): SuperagentReply<never> => ({ ok: false, error: `Invalid request: ${what}` });

/**
 * Starts Superagent and answers the window's calls. It is created inside a guard: if it cannot start, every call answers with that
 * reason and the rest of the app is unaffected.
 */
export function registerSuperagent(options: { dir: string; deps: AgentRunContextDeps }): SuperagentRegistration {
  const { deps } = options;
  let service: SuperagentService | undefined;
  let failure = "";
  try {
    const builtin = createBuiltinRegistry();
    service = new SuperagentService({
      dir: options.dir,
      cipher: createCipher({
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plain) => safeStorage.encryptString(plain),
        decrypt: (encrypted) => safeStorage.decryptString(encrypted),
      }),
      runner: {
        defaultModel: () => parseModelId(deps.settings.get().defaultModel),
        route: (providerId) => resolveProviderRouting(deps, providerId),
        contextLength: (providerId, model) => deps.getContextLength(providerId, model),
        options: () => ({ maxSteps: deps.settings.get().agentMaxSteps, thinking: deps.settings.get().thinking }),
        builtinTools: () => builtin,
      },
      broadcast: (view) => {
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CH.superagentChanged, view);
      },
      fetch: fetchNow,
      logger,
    });
    void service.start();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    logger.warn(`unavailable: ${failure}`);
    service = undefined;
  }

  const live = service;
  const unavailable = (): SuperagentReply<never> => ({ ok: false, error: `Superagent is unavailable: ${failure}` });
  const withService = <T>(run: (running: SuperagentService) => Promise<SuperagentReply<T>> | SuperagentReply<T>): Promise<SuperagentReply<T>> | SuperagentReply<T> =>
    live ? run(live) : unavailable();

  ipcMain.handle(CH.superagentView, () => withService((running) => running.current()));
  ipcMain.handle(CH.superagentSaveSettings, (_event, settings: unknown, baseRevision: unknown) =>
    withService((running) => (typeof baseRevision === "number" ? running.saveSettings(settings, baseRevision) : invalid("settings revision"))),
  );
  ipcMain.handle(CH.superagentSetToken, (_event, token: unknown) =>
    withService((running) => (typeof token === "string" ? running.setToken(token) : invalid("token"))),
  );
  ipcMain.handle(CH.superagentClearToken, () => withService((running) => running.clearToken()));
  ipcMain.handle(CH.superagentVerify, () => withService((running) => running.verify()));
  ipcMain.handle(CH.superagentStopTicket, (_event, ticketId: unknown) =>
    withService((running) => (typeof ticketId === "string" ? running.stopTicket(ticketId) : invalid("ticket id"))),
  );
  ipcMain.handle(CH.superagentRetryTicket, (_event, ticketId: unknown) =>
    withService((running) => (typeof ticketId === "string" ? running.retryTicket(ticketId) : invalid("ticket id"))),
  );
  ipcMain.handle(CH.superagentRequeue, (_event, triggerId: unknown) =>
    withService((running) => (typeof triggerId === "string" ? running.requeue(triggerId) : invalid("trigger id"))),
  );
  ipcMain.handle(CH.superagentReset, () => withService((running) => running.reset()));

  return {
    dispose: async () => {
      await live?.dispose();
    },
  };
}

/** Where Superagent keeps its data under the app's storage directory. */
export const superagentDir = (storageDir: string): string => join(storageDir, "superagent");
