import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotPermissionStore } from "../src/bots/permissions-store.js";
import { toolPermissionFor, type BotPermissionSettings } from "../src/bots/permissions.js";
import { BotError } from "../src/bots/types.js";
import { FileStorage } from "../src/storage.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function open(dir = mkdtempSync(join(tmpdir(), "deyin-botperm-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const storage = new FileStorage(dir);
  storages.push(storage);
  return { dir, storage, store: new BotPermissionStore(storage) };
}

const FILE = "bot-permissions.json";

test("a fresh install has the defaults and writes nothing", async () => {
  const h = open();
  assert.equal(h.store.get().autoReview.enabled, true);
  assert.deepEqual(h.store.get().scopes, {});
  await h.storage.flush();
  assert.equal(existsSync(join(h.dir, FILE)), false);
});

test("changes survive a restart", async () => {
  const first = open();
  first.store.update({ autoReview: { allowInstructions: ["Reply to my team"], blockInstructions: ["Never delete"] } });
  first.store.update({ tool: { scope: "gmail", tool: "send_email", permission: "needs_approval" } });
  await first.storage.flush();

  const second = open(first.dir);
  const settings = second.store.get();
  assert.deepEqual(settings.autoReview.allowInstructions, ["Reply to my team"]);
  assert.deepEqual(settings.autoReview.blockInstructions, ["Never delete"]);
  assert.equal(toolPermissionFor(settings, { name: "mcp__gmail__send_email" }), "needs_approval");
});

test("a refused change writes nothing and tells nobody", async () => {
  const h = open();
  h.store.update({ autoReview: { allowInstructions: ["keep"] } });
  await h.storage.flush();
  const before = readFileSync(join(h.dir, FILE), "utf8");
  let heard = 0;
  h.store.onChange(() => (heard += 1));
  assert.throws(() => h.store.update({ autoReview: { enabled: "yes" } }), (e: unknown) => e instanceof BotError && e.code === "invalid");
  assert.throws(() => h.store.update({ tool: { scope: "__proto__", tool: "x", permission: "blocked" } }), BotError);
  await h.storage.flush();
  assert.equal(readFileSync(join(h.dir, FILE), "utf8"), before);
  assert.equal(heard, 0);
  assert.deepEqual(h.store.get().autoReview.allowInstructions, ["keep"]);
});

test("listeners hear each change with the new settings, until they stop listening", () => {
  const h = open();
  const heard: BotPermissionSettings[] = [];
  const stop = h.store.onChange((s) => heard.push(s));
  h.store.update({ autoReview: { enabled: false } });
  h.store.rememberAlways("write_file");
  assert.equal(heard.length, 2);
  assert.equal(heard[0]?.autoReview.enabled, false);
  assert.equal(heard[1]?.scopes.local?.tools.write_file, "always_allow");
  stop();
  h.store.update({ autoReview: { enabled: true } });
  assert.equal(heard.length, 2);
});

test("always allow is saved so the next run starts with it", async () => {
  const first = open();
  first.store.rememberAlways("mcp__gmail__send_email");
  await first.storage.flush();
  const second = open(first.dir);
  assert.equal(toolPermissionFor(second.store.get(), { name: "mcp__gmail__send_email" }), "always_allow");
  assert.equal(toolPermissionFor(second.store.get(), { name: "mcp__gmail__delete_email" }), "needs_approval");
});

test("a damaged or hand-edited file is read as far as it makes sense", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-botperm-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, FILE),
    JSON.stringify({
      autoReview: { enabled: false, allowInstructions: ["fine", 7] },
      scopes: { gmail: { tools: { send_email: "blocked", odd: "maybe" } }, bad: "text" },
    }),
  );
  const { store } = open(dir);
  const settings = store.get();
  assert.equal(settings.autoReview.enabled, false);
  assert.deepEqual(settings.autoReview.allowInstructions, ["fine"]);
  assert.equal(toolPermissionFor(settings, { name: "mcp__gmail__send_email" }), "blocked");

  writeFileSync(join(dir, FILE), "{not json");
  assert.equal(open(dir).store.get().autoReview.enabled, true, "an unreadable file means the defaults");
});
