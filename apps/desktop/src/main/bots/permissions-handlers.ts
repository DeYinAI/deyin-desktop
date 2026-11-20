import { botResult, type BotPermissionSettings, type BotPermissionStore, type BotResult } from "@deyin/host-core";

export interface PermissionsHandlers {
  get(): BotPermissionSettings;
  update(patch: unknown): BotResult<BotPermissionSettings>;
}

/**
 * The permission IPC handlers over the store. The patch comes from the renderer, so it is validated by the
 * store (`updatePermissions`) and a refusal is returned as text, never thrown across the IPC boundary.
 */
export function createPermissionsHandlers(store: Pick<BotPermissionStore, "get" | "update">): PermissionsHandlers {
  return {
    get: () => store.get(),
    update: (patch) => botResult(() => store.update(patch)),
  };
}
