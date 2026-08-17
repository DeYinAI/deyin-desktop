/**
 * @deyin/contract — the typed RPC contract shared by every Deyin frontend and
 * host: the desktop IPC channel map (CH / DeyinApi), the domain types
 * re-exported from @deyin/host-core, service config defaults, and the web
 * client ↔ host-server WebSocket protocol. One package so main, preload,
 * renderer, web client and web server can never drift.
 */
export * from "./config.js";
export * from "./ipc.js";
export * from "./types.js";
