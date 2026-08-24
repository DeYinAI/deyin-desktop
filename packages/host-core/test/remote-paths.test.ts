import assert from "node:assert/strict";
import test from "node:test";
import { assertInsideRemoteRoot, normalizeRemotePath, shellQuote } from "../src/host/remote-paths.js";

test("normalizeRemotePath collapses dot segments", () => {
  assert.equal(normalizeRemotePath("/home/me/../me/foo"), "/home/me/foo");
});

test("assertInsideRemoteRoot rejects escapes", () => {
  assert.throws(() => assertInsideRemoteRoot("/home/me/project", "/etc/passwd"));
  assert.equal(assertInsideRemoteRoot("/home/me/project", "src/main.ts"), "/home/me/project/src/main.ts");
});

test("shellQuote escapes single quotes", () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});
