import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionStore } from "@deyin/agent-core";
import { removeBotSessions } from "../src/main/bots/sessions.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function store(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), "deyin-botsessions-"));
  dirs.push(dir);
  return new SessionStore(dir);
}

const base = { cwd: "/tmp", model: "GLM-5.2", agent: "build" };

test("deleting a Bot removes its conversations and nobody else's", () => {
  const s = store();
  const a1 = s.create({ ...base, botId: "a" });
  const a2 = s.create({ ...base, botId: "a" });
  const b = s.create({ ...base, botId: "b" });
  const code = s.create(base);
  const removed = removeBotSessions(s, new Map(), () => undefined, "a");
  assert.equal(removed, 2);
  assert.equal(s.load(a1.id), null);
  assert.equal(s.load(a2.id), null);
  assert.ok(s.load(b.id), "another Bot's conversation survives");
  assert.ok(s.load(code.id), "a Code conversation survives");
});

test("a thread still running one of the Bot's conversations is reset before its log is removed", () => {
  const s = store();
  const mine = s.create({ ...base, botId: "a" });
  const other = s.create({ ...base, botId: "b" });
  const live = new Map([
    ["thread-mine", { sessionId: mine.id }],
    ["thread-other", { sessionId: other.id }],
  ]);
  const order: string[] = [];
  const removed = removeBotSessions(
    s,
    live,
    (threadId) => order.push(`reset:${threadId}:${s.load(mine.id) ? "log-present" : "log-gone"}`),
    "a",
  );
  assert.equal(removed, 1);
  assert.deepEqual(order, ["reset:thread-mine:log-present"], "reset happens first, only for this Bot's thread");
});

test("resetting a thread may remove it from the live map without upsetting the cleanup", () => {
  const s = store();
  const mine = s.create({ ...base, botId: "a" });
  const live = new Map([["t", { sessionId: mine.id }]]);
  assert.doesNotThrow(() => removeBotSessions(s, live, (threadId) => live.delete(threadId), "a"));
  assert.equal(live.size, 0);
});

test("a Bot with no conversations removes nothing", () => {
  const s = store();
  s.create(base);
  assert.equal(removeBotSessions(s, new Map(), () => undefined, "nobody"), 0);
});
