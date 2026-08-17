/**
 * @deyin/bundle-headless — the headless/CLI profile: the base composition
 * minus anything that needs a UI or background caches. The CLI wires its own
 * capability scanning today; optimization stays off unless explicitly
 * requested.
 */
import type { ConfigLayer } from "@deyin/extension-api";

export const headlessProfile: ConfigLayer = {
  name: "profile:headless",
  rows: [{ id: "optimization", plugin: "@deyin/plugin-optimization", enabled: false }],
};
