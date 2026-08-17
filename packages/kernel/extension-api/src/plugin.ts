/**
 * Plugin definitions — the only shape the kernel loads. Everything a Deyin
 * process does (agent loop, tool families, LLM adapters, commands, skills
 * loaders) is expressed as one of these.
 */
import type { PluginContext } from "./context.js";

/** Where the process is running; plugins gate on this instead of sniffing. */
export interface HostEnvironment {
  /** "desktop" (Electron main), "web" (session host), "cli". */
  readonly app: "desktop" | "web" | "cli";
  readonly platform: NodeJS.Platform;
  /** Per-app writable root (Electron userData / session sandbox / ~/.deyin). */
  readonly userDataPath: string;
  /** Workspace root when one is open, else undefined (web sandbox root). */
  readonly workspaceRoot?: string;
}

/**
 * Event name that flips a lazy plugin from "registered" to "active".
 * Supports exact match and `prefix*` wildcard: `"onTool:git*"`.
 */
export type ActivationEvent = string;

export interface PluginDefinition<C = unknown> {
  /**
   * Globally unique plugin name, reverse-DNS or scoped:
   * "@deyin/plugin-tools-git", "acme/theme-pack".
   */
  readonly name: string;
  /**
   * Service ids this plugin provides. Declared statically so the kernel can
   * order activation before any code runs; must cover everything consumers
   * list in their `inject`.
   */
  readonly provides?: readonly string[];
  /**
   * Service ids that must be provided before `apply` runs. Drives load
   * ordering; a missing or failed dependency fails this plugin in isolation.
   */
  readonly inject?: readonly string[];
  /**
   * Defer activation until one of these events fires. Omit to activate
   * eagerly at startup.
   */
  readonly activateOn?: readonly ActivationEvent[];
  /** Runtime gate (platform/app); a false return skips the plugin silently. */
  readonly applies?: (env: HostEnvironment) => boolean;
  /** Wire the plugin into the context: provide services, listen, register. */
  apply(ctx: PluginContext, config: C): void | Promise<void>;
}

export type PluginState =
  | "registered" // known to the kernel, not yet applied
  | "active" // apply() succeeded
  | "lazy" // waiting for an activateOn match
  | "failed" // apply() threw or a dependency failed; isolated
  | "disposed"; // cleanly shut down

export interface PluginStatus {
  readonly name: string;
  readonly state: PluginState;
  readonly error?: string;
  /** Config row source that pulled this plugin in, for diagnostics. */
  readonly source?: string;
}
