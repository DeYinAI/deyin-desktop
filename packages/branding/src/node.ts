import { fileURLToPath } from "node:url";

/** Absolute path to a brand asset (for the Electron main process / build tooling). */
export function assetPath(name: "logo-mark.svg" | "logo-wordmark.svg"): string {
  return fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
}
