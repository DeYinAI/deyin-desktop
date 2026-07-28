/**
 * Service configuration now lives in @deyin/host-core (shared by desktop, web and CLI).
 * Re-exported here so main-process modules keep their stable `shared/config.js` path.
 */
export {
  DEFAULT_CONFIG,
  DEEP_LINK_SCHEME,
  DEEP_LINK_REDIRECT_URI,
  resolveDeyinConfig,
  type DeyinConfig,
} from "@deyin/host-core/shared";
