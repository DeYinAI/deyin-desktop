/**
 * PluginContext — the only object a plugin receives. It exposes seams
 * (services), events, waterfall interception, scoped registration, and
 * lifecycle cleanup. There is deliberately no access to the kernel internals
 * or to other plugins' private state.
 */
import type { ServiceKey } from "./service.js";
import type { EventListener, EventName, Unsubscribe, WaterfallListener } from "./events.js";
import type { HostEnvironment } from "./plugin.js";

export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /** A child logger with the given prefix, e.g. `logger.child("tools-git")`. */
  child(prefix: string): PluginLogger;
}

export interface PluginContext {
  /** Plugin name this context was created for (also the logger prefix). */
  readonly pluginName: string;
  /** Host environment snapshot; gate behavior on this instead of sniffing. */
  readonly env: HostEnvironment;
  readonly logger: PluginLogger;

  /** Resolve a service. Throws if no provider is active in this scope. */
  get<T>(key: ServiceKey<T>): T;
  /** Resolve a service or undefined — for optional integrations. */
  tryGet<T>(key: ServiceKey<T>): T | undefined;

  /**
   * Provide a service implementation. Fails (marks the plugin failed) if
   * another plugin already provides the key in the same scope; child scopes
   * may shadow parents (most-specific scope wins).
   */
  provide<T>(key: ServiceKey<T>, value: T | (() => T)): void;

  /** Subscribe to an event; returns an unsubscribe handle. */
  on<E extends EventName>(event: E, listener: EventListener<E>): Unsubscribe;
  /** Subscribe for exactly one delivery. */
  once<E extends EventName>(event: E, listener: EventListener<E>): Unsubscribe;
  /** Emit an event. Listeners run synchronously-started; async listeners are
   *  awaited fire-and-forget with errors logged, never thrown to the emitter.
   *  Emitting an activation pattern also wakes matching lazy plugins. */
  emit<E extends EventName>(event: E, payload: Parameters<EventListener<E>>[0]): void;

  /** Add middleware to a waterfall chain (registration order). */
  onWaterfall<T>(event: EventName, listener: WaterfallListener<T>): Unsubscribe;
  /** Run a value through a waterfall chain sequentially. */
  waterfall<T>(event: EventName, seed: T): Promise<T>;

  /**
   * Register a cleanup that runs when this plugin is disposed (or fails
   * mid-apply). Cleanup order is reverse-registration (LIFO).
   */
  effect(cleanup: () => void | Promise<void>): void;

  /**
   * Create a child scope for scoped registration (e.g. one agent run).
   * Services provided on the child shadow the parent's; the child and
   * everything registered on it is disposed together.
   */
  scope(name: string): PluginScope;
}

export interface PluginScope extends PluginContext {
  readonly scopeName: string;
  /** Dispose this scope: run its effects (LIFO) and drop its services. */
  dispose(): Promise<void>;
}
