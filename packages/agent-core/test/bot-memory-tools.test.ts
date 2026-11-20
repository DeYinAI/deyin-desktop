/**
 * A Bot's memory is a `MemoryBridge`, so the memory tools and automatic recall work on it without
 * knowing it is partitioned. These tests run the real tools against `BotMemory`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotMemory } from "@deyin/host-core";
import { buildRecallSuffix } from "../src/recall.js";
import { createForgetTool, createMemoryTool, createRememberTool } from "../src/tools/memory.js";
import type { MemoryBridge, ToolContext } from "../src/types.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function bots() {
  const dir = mkdtempSync(join(tmpdir(), "deyin-botmemtool-"));
  dirs.push(dir);
  const botsDir = join(dir, "bots");
  const ctxFor = (memory: MemoryBridge): ToolContext => ({ cwd: dir, todos: [], memory }) as ToolContext;
  return { botsDir, ctxFor };
}

test("a BotMemory satisfies the MemoryBridge contract", () => {
  const { botsDir } = bots();
  const bridge: MemoryBridge = new BotMemory(botsDir, "bot_ava");
  assert.equal(typeof bridge.create, "function");
});

test("remember with the default scope saves a private fact only that Bot can recall", async () => {
  const { botsDir, ctxFor } = bots();
  const ava = new BotMemory(botsDir, "bot_ava");
  const bo = new BotMemory(botsDir, "bot_bo");
  const remember = createRememberTool();
  const saved = await remember.execute({ title: "Favorite tea", body: "Ava prefers oolong." }, ctxFor(ava));
  assert.match(saved, /Saved memory project\/favorite-tea/);
  assert.equal(ava.read("favorite-tea")?.body, "Ava prefers oolong.");
  assert.equal(bo.read("favorite-tea"), undefined);
  const memory = createMemoryTool();
  assert.match(await memory.execute({}, ctxFor(ava)), /oolong/, "the owner's own listing shows it");
  assert.equal(await memory.execute({}, ctxFor(bo)), "(no saved memories)", "another Bot's listing is empty");
  assert.match(await memory.execute({ query: "oolong tea" }, ctxFor(bo)), /No relevant memories/);
  assert.match(await memory.execute({ ref: "favorite-tea" }, ctxFor(bo)), /No memory found/);
});

test("remember with scope global shares the fact with every Bot", async () => {
  const { botsDir, ctxFor } = bots();
  const ava = new BotMemory(botsDir, "bot_ava");
  const bo = new BotMemory(botsDir, "bot_bo");
  const saved = await createRememberTool().execute({ title: "Timezone", body: "The user is in Berlin.", scope: "global" }, ctxFor(ava));
  assert.match(saved, /Saved memory global\/timezone/);
  assert.equal(bo.read("timezone")?.body, "The user is in Berlin.");
});

test("remember updates a fact it can already see and can share it by changing scope", async () => {
  const { botsDir, ctxFor } = bots();
  const ava = new BotMemory(botsDir, "bot_ava");
  const bo = new BotMemory(botsDir, "bot_bo");
  const remember = createRememberTool();
  await remember.execute({ title: "Name", body: "Sam" }, ctxFor(ava));
  const updated = await remember.execute({ title: "Name", body: "Sam Lee", scope: "global" }, ctxFor(ava));
  assert.match(updated, /Updated memory global\/name/);
  assert.equal(bo.read("name")?.body, "Sam Lee");
});

test("forget removes a fact for the Bot, and for everyone when it was shared", async () => {
  const { botsDir, ctxFor } = bots();
  const ava = new BotMemory(botsDir, "bot_ava");
  const bo = new BotMemory(botsDir, "bot_bo");
  await createRememberTool().execute({ title: "Shared note", body: "everyone sees this", scope: "global" }, ctxFor(ava));
  const result = await createForgetTool().execute({ ref: "shared-note" }, ctxFor(ava));
  assert.match(result, /Forgot/);
  assert.equal(bo.read("shared-note"), undefined);
});

test("remember still refuses credentials for a Bot", async () => {
  const { botsDir, ctxFor } = bots();
  const ava = new BotMemory(botsDir, "bot_ava");
  const refused = await createRememberTool().execute({ title: "Creds", body: "password: hunter2" }, ctxFor(ava));
  assert.match(refused, /refusing/);
  assert.equal(ava.count(), 0);
});

test("automatic recall draws on a Bot's own and shared facts and nobody else's", async () => {
  const { botsDir, ctxFor } = bots();
  const ava = new BotMemory(botsDir, "bot_ava");
  const bo = new BotMemory(botsDir, "bot_bo");
  const remember = createRememberTool();
  await remember.execute({ title: "Deploy checklist", body: "Run the smoke tests before every deploy." }, ctxFor(ava));
  await remember.execute({ title: "Deploy window", body: "Deploys are allowed on weekdays only.", scope: "global" }, ctxFor(bo));
  await remember.execute({ title: "Deploy secrets vault", body: "Bo keeps the deploy vault in a private place." }, ctxFor(bo));

  const suffix = buildRecallSuffix(ava, "how do we deploy?") ?? "";
  assert.match(suffix, /smoke tests/);
  assert.match(suffix, /weekdays only/);
  assert.doesNotMatch(suffix, /private place/, "another Bot's private fact is not recalled");
});
