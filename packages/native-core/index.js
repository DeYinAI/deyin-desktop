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
};
