import { BotError, botResult, type BotResult, type VaultItem, type VaultSnapshot, type VaultStore } from "@deyin/host-core";

export interface VaultHandlers {
  get(): VaultSnapshot;
  save(input: unknown): BotResult<VaultItem>;
  remove(id: unknown): BotResult<null>;
  revoke(botId: unknown, itemId: unknown, host: unknown): BotResult<null>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new BotError("invalid", `${what} is required.`);
  return value;
}

/**
 * The Vault IPC handlers over the store. Everything arrives from the renderer, so it is validated here and a
 * refusal is returned as text, never thrown across the IPC boundary. No handler returns a secret: the snapshot
 * and a saved item carry only what the Vault page may show.
 */
export function createVaultHandlers(store: Pick<VaultStore, "snapshot" | "put" | "remove" | "revoke">): VaultHandlers {
  return {
    get: () => store.snapshot(),
    save: (input) => botResult(() => store.put(input)),
    remove: (id) =>
      botResult(() => {
        store.remove(text(id, "The item"));
        return null;
      }),
    revoke: (botId, itemId, host) =>
      botResult(() => {
        store.revoke(text(botId, "The Bot"), text(itemId, "The item"), text(host, "The site"));
        return null;
      }),
  };
}
