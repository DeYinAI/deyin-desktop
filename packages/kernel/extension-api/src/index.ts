/**
 * @deyin/extension-api — the contracts plugins are written against.
 * Zero runtime dependencies by design: this package is the bottom of the
 * dependency graph (`apps → plugin packages → kernel → extension-api`).
 */
export { defineService } from "./service.js";
export type { ServiceKey } from "./service.js";
export type {
  EventListener,
  EventName,
  EventPayload,
  PluginEvents,
  Unsubscribe,
  WaterfallListener,
} from "./events.js";
export type {
  ActivationEvent,
  HostEnvironment,
  PluginDefinition,
  PluginState,
  PluginStatus,
} from "./plugin.js";
export type { PluginContext, PluginLogger, PluginScope } from "./context.js";
export type {
  ConfigLayer,
  PluginConfigRow,
  ResolvedConfig,
} from "./config.js";
