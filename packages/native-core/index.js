// Minimal napi-rs v3 loader. The .node binary exports plain functions; we
// re-export them with the TS-facing names.
const { existsSync } = require("node:fs");
const { join } = require("node:path");

function loadNative() {
  const candidates = [
    join(__dirname, "deyin-native.node"),
    // Repo-local build output (dev / monorepo builds).
    join(__dirname, "../../native/deyin-native/target/release", process.platform === "win32" ? "deyin_native.dll" : `libdeyin_native.${process.platform === "darwin" ? "dylib" : "so"}`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return require(p);
      } catch {
        // Wrong platform binary etc — try next candidate.
      }
    }
  }
  return null;
}

const native = loadNative();

module.exports = {
  available: native !== null,
  parseSseDataLine: native ? (line) => native.parseSseDataLine(line) : null,
  frameSseChunk: native ? (buffer, chunk) => native.frameSseChunk(buffer, chunk) : null,
  countTokens: native ? (text) => native.countTokens(text) : null,
  truncateToTokens: native ? (text, max) => native.truncateToTokens(text, max) : null,
  compressWireText: native ? (content, mode) => native.compressWireText(content, mode) : null,
  compressWireTextEx: native
    ? (content, mode, toolName, preserveErrors) =>
        native.compressWireTextEx(content, mode, toolName ?? null, preserveErrors ?? null)
    : null,
  grep: native
    ? (root, pattern, glob, maxResults, ignoreCase) =>
        native.grep(root, pattern, glob ?? null, maxResults ?? null, ignoreCase ?? null)
    : null,
  frameAcpChunk: native ? (buffer, chunk) => native.frameAcpChunk(buffer, chunk) : null,
  isJsonRpc: native ? (line) => native.isJsonRpc(line) : null,
  frameNdjsonChunk: native ? (buffer, chunk) => native.frameNdjsonChunk(buffer, chunk) : null,
  ringBufferAppend: native ? (bufferId, line, capacity) => native.ringBufferAppend(bufferId, line, capacity ?? null) : null,
  ringBufferGetLines: native ? (bufferId, maxLines) => native.ringBufferGetLines(bufferId, maxLines ?? null) : null,
  ringBufferClear: native ? (bufferId) => native.ringBufferClear(bufferId) : null,
  ringBufferRemove: native ? (bufferId) => native.ringBufferRemove(bufferId) : null,
  watchdogRegister: native
    ? (id, pid, timeoutMs, stallThresholdMs, nowMs) =>
        native.watchdogRegister(id, pid, timeoutMs, stallThresholdMs, nowMs ?? null)
    : null,
  watchdogHeartbeat: native ? (id, nowMs) => native.watchdogHeartbeat(id, nowMs ?? null) : null,
  watchdogCheck: native ? (id, nowMs) => native.watchdogCheck(id, nowMs ?? null) : null,
  watchdogUnregister: native ? (id) => native.watchdogUnregister(id) : null,
};
