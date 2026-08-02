import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStore } from "@deyin/host-core";
import type { ToolContext } from "../src/types.js";
import { createForgetTool, createMemoryTool, createRememberTool } from "../src/tools/memory.js";

function ctxWithMemory(dir: string): { ctx: ToolContext; store: MemoryStore } {
  const store = new MemoryStore(dir);
  return {
    store,
    ctx: {
      cwd: dir,
      todos: [],
      memory: store,
    } as ToolContext,
  };
}

test("remember creates a fact; updating the same name bumps revision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-memtool-"));
  try {
    const { ctx, store } = ctxWithMemory(dir);
    const remember = createRememberTool();
    const created = await remember.execute({ title: "Release branch", body: "Releases go through release/*.", type: "project", scope: "project" }, ctx);
    assert.match(created, /Saved memory project\/release-branch/);
    const updated = await remember.execute({ title: "Release branch", body: "Releases go through main.", type: "project" }, ctx);
    assert.match(updated, /Updated memory project\/release-branch \(revision 2\)/);
    assert.equal(store.read("release-branch")?.revision, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remember refuses credentials; forget archives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-memtool-"));
  try {
    const { ctx, store } = ctxWithMemory(dir);
    const remember = createRememberTool();
    const secret = await remember.execute({ title: "Creds", body: "api_key=sk-1234abcd" }, ctx);
    assert.match(secret, /refusing/);
    assert.equal(store.count(), 0);
    await remember.execute({ title: "Temp", body: "Temporary note." }, ctx);
    const forget = createForgetTool();
    const result = await forget.execute({ ref: "temp" }, ctx);
    assert.match(result, /Forgot memory "temp"/);
    assert.equal(store.count(), 0);
    assert.equal(store.archived().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory tool searches, reads by ref, and lists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-memtool-"));
  try {
    const { ctx, store } = ctxWithMemory(dir);
    await store.create({ name: "ci", title: "CI pipeline", type: "reference", body: "CI runs pnpm test on every push." });
    const memory = createMemoryTool();
    const hits = await memory.execute({ query: "pnpm test" }, ctx);
    assert.match(hits, /project\/ci/);
    assert.match(hits, /CI runs pnpm test/);
    const byRef = await memory.execute({ ref: "project/ci" }, ctx);
    assert.match(byRef, /CI pipeline/);
    const none = await memory.execute({ query: "zzzqqq" }, ctx);
    assert.match(none, /No relevant memories/);
    const listed = await memory.execute({}, ctx);
    assert.match(listed, /Saved memories/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory tools report unavailable bridge gracefully", async () => {
  const ctx = { cwd: "/tmp", todos: [] } as ToolContext;
  const remember = createRememberTool();
  assert.match(await remember.execute({ title: "X", body: "y" }, ctx), /not available/);
});
