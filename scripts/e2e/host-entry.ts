// Bundle entry for the Windows Chrome end-to-end harness (chrome-extension-e2e.mjs).
// esbuild turns this into one ESM file so a plain `node.exe` can run the real
// relay, control service and tools without a TypeScript toolchain.
export * from "../../apps/desktop/bundled-plugins/chrome/host/chrome-bridge.js";
export * from "../../apps/desktop/bundled-plugins/chrome/host/chrome-control.js";
export * from "../../apps/desktop/bundled-plugins/chrome/host/chrome-tools.js";
export { DEYIN_EXTENSION_ID } from "../../apps/desktop/bundled-plugins/chrome/host/chrome-protocol.js";
