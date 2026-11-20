import { useSyncExternalStore } from "react";
import { createBotsClient, type BotsApi, type BotsClient, type BotsClientState } from "./botsClient.js";

let shared: BotsClient | null = null;

/** The window's one Bots client, created on first use from the host API (absent in tests and old hosts). */
export function sharedBotsClient(): BotsClient {
  if (!shared) {
    const api: BotsApi | undefined = typeof window === "undefined" ? undefined : window.deyin?.bots;
    shared = createBotsClient(api);
  }
  return shared;
}

export interface UseBots extends BotsClientState {
  actions: BotsApi;
}

export function useBots(client: BotsClient = sharedBotsClient()): UseBots {
  const state = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  return { ...state, actions: client.actions };
}
