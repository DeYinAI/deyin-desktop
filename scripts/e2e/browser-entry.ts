// Bundle entry for the Electron in-app browser end-to-end harness (browser-electron-e2e.cjs).
// esbuild turns this into one CJS file that the harness loads inside a real Electron
// main process, so the actual BrowserControlService drives a real <webview>.
export { BrowserControlService } from "../../apps/desktop/bundled-plugins/browser/host/browser-control.js";
