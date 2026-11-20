// Bundle entry for the Windows overlay end-to-end harness (overlay-electron-e2e.cjs): the real overlay and the real
// pipe client, so a plain Windows Electron can show the overlay and ask the real C# host what it can see.
export { ComputerUseOverlay } from "../../apps/desktop/src/main/computer-use-overlay.js";
export { PipeComputerUseHost } from "../../native/computer-use-host/src/index.js";
