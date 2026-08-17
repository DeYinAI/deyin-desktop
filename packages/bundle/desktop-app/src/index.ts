/**
 * @deyin/bundle-desktop-app — the desktop (Electron main) profile. Patches
 * the base bundle with host-specific config: optimization data/model dirs.
 * Capability scanning stays on the desktop's own CapabilityService until it
 * migrates onto the caps seam.
 */
import type { ConfigLayer } from "@deyin/extension-api";

export interface DesktopProfileOptions {
  /** Electron userData path. */
  userDataPath: string;
  /** Packaged extraResources model dir, when present. */
  packagedModelDir?: string;
}

export function createDesktopProfile(options: DesktopProfileOptions): ConfigLayer {
  return {
    name: "profile:desktop",
    rows: [
      {
        id: "optimization",
        plugin: "@deyin/plugin-optimization",
        config: {
          dataDir: `${options.userDataPath}/plugins/optimization`,
          packagedModelDir: options.packagedModelDir,
          enableToolCache: true,
          enableResponseCache: true,
          similarityThreshold: 0.93,
        },
      },
    ],
  };
}
