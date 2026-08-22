/**
 * @deyin/bundle-web-app — the web session-host profile. Adds a
 * sandbox-scoped capabilities scan: userDir/pluginsDir point inside the
 * per-session sandbox so a session sees its own .deyin workspace and never
 * the server's real home.
 */
import type { ConfigLayer } from "@deyin/extension-api";

export interface WebProfileOptions {
  /** Per-session sandbox root (mkdtemp/container volume). */
  sandboxRoot: string;
}

export function createWebProfile(options: WebProfileOptions): ConfigLayer {
  return {
    name: "profile:web",
    rows: [
      {
        id: "caps-local",
        plugin: "@deyin/plugin-caps-local",
        config: {
          cwd: options.sandboxRoot,
          userDir: options.sandboxRoot,
          pluginsDir: `${options.sandboxRoot}/plugins`,
          eager: true,
        },
      },
      // Cache parity with desktop: semantic tool/response caches scoped to the
      // session sandbox, activated on demand (optimization:activate).
      {
        id: "optimization",
        plugin: "@deyin/plugin-optimization",
        config: {
          dataDir: `${options.sandboxRoot}/plugins/optimization`,
          enableToolCache: true,
          enableResponseCache: true,
          similarityThreshold: 0.93,
        },
      },
    ],
  };
}
