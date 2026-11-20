import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { migrateSessionMeta } from "../src/migration/session-v2.js";
import { SessionStore } from "../src/session.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The directory behind each store; `SessionStore.dir` is private on purpose. */
const dirOf = new WeakMap<SessionStore, string>();

function store(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), "deyin-sessionbot-"));
  dirs.push(dir);
  const created = new SessionStore(dir);
  dirOf.set(created, dir);
  return created;
}

const base = { cwd: "/tmp", model: "GLM-5.2", agent: "build" };

test("a session created for a Bot carries its botId through reload and listing", () => {
  const s = store();
  const meta = s.create({ ...base, botId: "bot_1" });
  assert.equal(meta.botId, "bot_1");
  assert.equal(s.load(meta.id)?.meta.botId, "bot_1");
  assert.equal(s.list().find((m) => m.id === meta.id)?.botId, "bot_1");
});

test("a session created without a Bot has no botId, so Code sessions are unchanged", () => {
  const s = store();
  const meta = s.create(base);
  assert.equal(meta.botId, undefined);
  assert.equal("botId" in (s.load(meta.id)?.meta ?? {}), false);
});

test("sessions written before Bots existed still load, with no botId", () => {
  const s = store();
  const meta = s.create(base);
  const file = join(dirOf.get(s)!, `${meta.id}.jsonl`);
  const lines = readFileSync(file, "utf8").split("\n");
  const first = JSON.parse(lines[0]!) as { meta: Record<string, unknown> };
  assert.equal("botId" in first.meta, false, "nothing is written for Code sessions");
  writeFileSync(file, lines.join("\n"));
  assert.equal(s.load(meta.id)?.meta.botId, undefined);
});

test("a fork of a Bot's session stays that Bot's", () => {
  const s = store();
  const meta = s.create({ ...base, botId: "bot_7" });
  s.append(meta.id, { role: "user", content: "hello" });
  const fork = s.fork(meta.id);
  assert.equal(fork?.botId, "bot_7");
  assert.equal(s.load(fork!.id)?.meta.botId, "bot_7");
});

test("listForBot returns only that Bot's sessions", () => {
  const s = store();
  const a1 = s.create({ ...base, botId: "a" });
  const a2 = s.create({ ...base, botId: "a" });
  s.create({ ...base, botId: "b" });
  s.create(base);
  const ids = s.listForBot("a").map((m) => m.id).sort();
  assert.deepEqual(ids, [a1.id, a2.id].sort());
  assert.deepEqual(s.listForBot("missing"), []);
});

test("an imported snapshot never claims a Bot from the file, only from the caller", () => {
  const s = store();
  const source = s.create({ ...base, botId: "bot_from_file" });
  s.append(source.id, { role: "user", content: "hi" });
  const snapshot = s.exportSnapshot(source.id);
  assert.equal(snapshot?.meta.botId, "bot_from_file", "the export records its origin");

  const plain = s.importSnapshot(snapshot);
  assert.equal(plain?.botId, undefined, "a file cannot attach itself to a Bot that may not exist here");

  const adopted = s.importSnapshot(snapshot, { botId: "local_bot" });
  assert.equal(adopted?.botId, "local_bot");
});

test("migrateSessionMeta keeps a string botId and drops anything else", () => {
  assert.equal(migrateSessionMeta({ id: "s", botId: "bot_1" }).botId, "bot_1");
  for (const bad of [1, null, {}, "", ["x"]]) {
    assert.equal(migrateSessionMeta({ id: "s", botId: bad }).botId, undefined, `drops ${JSON.stringify(bad)}`);
  }
});
