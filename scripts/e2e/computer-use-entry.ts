// Bundle entry for the Windows computer-use end-to-end harness (computer-use-e2e.mjs): the real pipe client
// and API, so a plain node.exe can drive the real C# host the same way Deyin does.
export * from "../../native/computer-use-host/src/index.js";
