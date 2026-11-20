import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotPermissionStore, FileStorage, toolPermissionFor } from "@deyin/host-core";
import { createPermissionsHandlers } from "../src/main/bots/permissions-handlers.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "deyin-permh-"));
  dirs.push(dir);
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotPermissionStore(storage);
  return { store, handlers: createPermissionsHandlers(store) };
}

test("get returns the saved settings", () => {
  const { store, handlers } = setup();
  assert.deepEqual(handlers.get(), store.get());
  assert.equal(handlers.get().autoReview.enabled, true);
});

test("an update is applied and returned", () => {
  const { handlers } = setup();
  const result = handlers.update({ autoReview: { blockInstructions: ["Never delete files"] }, tool: { scope: "gmail", tool: "send_email", permission: "blocked" } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.autoReview.blockInstructions, ["Never delete files"]);
  assert.equal(toolPermissionFor(result.value, { name: "mcp__gmail__send_email" }), "blocked");
  assert.deepEqual(handlers.get(), result.value, "what was returned is what is saved");
});

test("a refusal comes back as text with a code, and changes nothing", () => {
  const { handlers } = setup();
  handlers.update({ autoReview: { allowInstructions: ["keep"] } });
  const before = JSON.stringify(handlers.get());
  for (const bad of [null, 5, "x", [], { autoReview: 7 }, { tool: { scope: "__proto__", tool: "x", permission: "blocked" } }, { tool: { scope: "a", tool: "b", permission: "maybe" } }]) {
    const result = handlers.update(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    if (!result.ok) {
      assert.ok(result.error.length > 0);
      assert.equal(result.code, "invalid");
    }
  }
  assert.equal(JSON.stringify(handlers.get()), before);
});

test("a bug is not hidden as a refusal", () => {
  const handlers = createPermissionsHandlers({
    get: () => {
      throw new Error("disk gone");
    },
    update: () => {
      throw new TypeError("not a BotError");
    },
  });
  assert.throws(() => handlers.update({}), TypeError);
  assert.throws(() => handlers.get(), /disk gone/);
});
