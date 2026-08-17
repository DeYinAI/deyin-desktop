export { PluginKernel, matchesActivation } from "./kernel.js";
export type { KernelOptions } from "./kernel.js";
export { resolveConfig } from "./config.js";
export { ConsoleLogger } from "./logger.js";
export type { LogLevel } from "./logger.js";
export {
  createRegistration,
  DuplicateServiceError,
  EventBus,
  MissingServiceError,
  ScopeImpl,
} from "./scope.js";
export type { PluginRegistration } from "./scope.js";
