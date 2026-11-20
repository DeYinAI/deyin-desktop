import type { Storage } from "../storage.js";
import {
  EMPTY_PERMISSIONS,
  normalizePermissions,
  rememberAlwaysAllow,
  updatePermissions,
  type BotPermissionSettings,
} from "./permissions.js";

const FILE = "bot-permissions.json";

type StorageLike = Pick<Storage, "readJson" | "writeJson">;

/**
 * The Bot permission settings on disk (`bot-permissions.json`). Account-wide: the tool permissions and the
 * auto review instructions apply to every Bot; each Bot's approval mode lives on the Bot itself. A change is
 * validated by `updatePermissions` before anything is written, so a refused change leaves the file alone.
 */
export class BotPermissionStore {
  private settings: BotPermissionSettings;
  private readonly listeners = new Set<(settings: BotPermissionSettings) => void>();

  constructor(private readonly storage: StorageLike) {
    this.settings = normalizePermissions(storage.readJson<unknown>(FILE, EMPTY_PERMISSIONS));
  }

  get(): BotPermissionSettings {
    return this.settings;
  }

  onChange(listener: (settings: BotPermissionSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply a patch from the UI. Throws `BotError` and changes nothing when it is not acceptable. */
  update(patch: unknown): BotPermissionSettings {
    return this.commit(updatePermissions(this.settings, patch));
  }

  /** "Always allow" from an approval card. */
  rememberAlways(toolName: string): BotPermissionSettings {
    return this.commit(rememberAlwaysAllow(this.settings, toolName));
  }

  private commit(next: BotPermissionSettings): BotPermissionSettings {
    this.storage.writeJson(FILE, next);
    this.settings = next;
    for (const listener of [...this.listeners]) listener(next);
    return next;
  }
}
