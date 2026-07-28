import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Logger } from "../src/host/logger.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-log-test-"));
}

test("Logger writes levelled lines to deyin.log", () => {
  const dir = tempDir();
  try {
    const log = new Logger(dir);
    log.info("hello");
    log.error("boom");
    const content = readFileSync(join(dir, "deyin.log"), "utf8");
    assert.match(content, /INFO\s+hello/);
    assert.match(content, /ERROR\s+boom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Logger rotates when the file passes maxBytes", () => {
  const dir = tempDir();
  try {
    const log = new Logger(dir, { maxBytes: 500, maxFiles: 2 });
    for (let i = 0; i < 40; i++) log.info(`line ${i} ${"x".repeat(40)}`);
    assert.ok(existsSync(join(dir, "deyin.1.log")), "expected a rotated generation");
    assert.ok(existsSync(join(dir, "deyin.log")), "current log must still exist");
    assert.ok(!existsSync(join(dir, "deyin.3.log")), "generations beyond maxFiles drop off");
    // The current file restarts small after rotation.
    const current = readFileSync(join(dir, "deyin.log"), "utf8");
    assert.ok(current.includes("line 39"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Logger.tail returns the end of the file within the byte cap", () => {
  const dir = tempDir();
  try {
    const log = new Logger(dir);
    for (let i = 0; i < 30; i++) log.info(`row-${i}`);
    const full = readFileSync(join(dir, "deyin.log"), "utf8");
    const tail = log.tail(200);
    assert.ok(tail.length <= 200);
    assert.ok(full.endsWith(tail), "tail must be a suffix of the log");
    assert.ok(tail.includes("row-29"));
    assert.ok(!tail.includes("row-0\n"), "tail must not contain the oldest lines");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Logger.tail of a missing log is empty", () => {
  const dir = tempDir();
  try {
    const log = new Logger(dir);
    assert.equal(log.tail(100), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
