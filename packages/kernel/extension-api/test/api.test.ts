import assert from "node:assert/strict";
import { test } from "node:test";
import { defineService } from "../src/service.js";

test("defineService mints stable, distinct keys", () => {
  const a = defineService<{ run(): void }>("tools", "tool registry");
  const b = defineService<{ run(): void }>("tools", "tool registry");
  const anon = defineService<unknown>();
  assert.equal(a.id, "tools");
  assert.equal(a.description, "tool registry");
  assert.notEqual(anon.id, "tools");
  assert.notEqual(anon.id, defineService().id, "anonymous ids must not collide");
  // Keys are value types: identical ids resolve identically in the kernel.
  assert.deepEqual(a, b);
});
