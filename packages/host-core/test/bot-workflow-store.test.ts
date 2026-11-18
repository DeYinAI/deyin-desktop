import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotWorkflowsStore, type BotWorkflowDefinition } from "../src/index.js";

function pipeline(id: string, updatedAt = 1): BotWorkflowDefinition {
  return {
    id,
    name: id,
    stages: [{ id: "only", name: "Only", agentId: "claude", userPromptTemplate: "go" }],
    createdAt: 1,
    updatedAt,
  };
}

function workspaceWith(...ids: string[]): { root: string; fileFor: (id: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "deyin-bot-store-"));
  const dir = join(root, ".deyin", "workflows");
  mkdirSync(dir, { recursive: true });
  for (const id of ids) writeFileSync(join(dir, `${id}.json`), JSON.stringify(pipeline(id)));
  return { root, fileFor: (id) => join(dir, `${id}.json`) };
}

test("a workspace root getter follows the folder the user opens after startup", () => {
  const first = workspaceWith("from-first");
  const second = workspaceWith("from-second");
  try {
    let current: string | null = first.root;
    const store = new BotWorkflowsStore(undefined, () => current);
    assert.deepEqual(store.list().map((w) => w.id), ["from-first"]);

    current = second.root;
    assert.deepEqual(store.list().map((w) => w.id), ["from-second"], "the new workspace's pipelines must appear");

    current = null;
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("a fixed root string still works, and unparseable files are skipped", () => {
  const ws = workspaceWith("good");
  try {
    writeFileSync(join(ws.root, ".deyin", "workflows", "broken.json"), "{ not json");
    const store = new BotWorkflowsStore(undefined, ws.root);
    assert.deepEqual(store.list().map((w) => w.id), ["good"]);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("delete removes the workspace file, so the pipeline does not come back", () => {
  const ws = workspaceWith("keep", "drop");
  try {
    const store = new BotWorkflowsStore(undefined, ws.root);
    assert.equal(store.delete("drop"), true);
    assert.equal(existsSync(ws.fileFor("drop")), false);
    assert.equal(existsSync(ws.fileFor("keep")), true, "other pipelines are untouched");
    assert.deepEqual(store.list().map((w) => w.id), ["keep"]);
    assert.equal(store.delete("drop"), false, "deleting something already gone reports false");
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("a saved copy shadows the workspace file of the same id, and delete clears both", () => {
  const ws = workspaceWith("shared");
  try {
    const store = new BotWorkflowsStore(undefined, ws.root);
    store.save({ ...pipeline("shared"), name: "Edited in the editor" });
    assert.equal(store.get("shared")?.name, "Edited in the editor");

    assert.equal(store.delete("shared"), true);
    assert.equal(store.get("shared"), undefined);
    assert.equal(existsSync(ws.fileFor("shared")), false);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});
