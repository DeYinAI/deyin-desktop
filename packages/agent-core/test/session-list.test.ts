import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionStore } from "../src/session.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function store(): { s: SessionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "deyin-sessionlist-"));
  dirs.push(dir);
  return { s: new SessionStore(dir), dir };
}

/** Force distinct mtimes so ordering is deterministic across filesystems. */
function touch(dir: string, id: string, msAgo: number): void {
  const when = new Date(Date.now() - msAgo);
  utimesSync(join(dir, `${id}.jsonl`), when, when);
}

test("list() derives title, count, and newest-first ordering", () => {
  const { s, dir } = store();
  const older = s.create({ cwd: "/a", model: "m", agent: "build" });
  s.append(older.id, { role: "user", content: "fix the   login bug please" });
  s.append(older.id, { role: "assistant", content: "on it" });
  const newer = s.create({ cwd: "/b", model: "m", agent: "build" });
  s.append(newer.id, { role: "user", content: "second session" });
  touch(dir, older.id, 10_000);
  touch(dir, newer.id, 1_000);

  const metas = s.list();
  assert.deepEqual(
    metas.map((m) => m.id),
    [newer.id, older.id],
    "newest first",
  );
  const first = metas[0]!;
  assert.equal(first.messageCount, 1);
  assert.equal(first.cwd, "/b");
  const second = metas[1]!;
  assert.equal(second.messageCount, 2);
  assert.equal(second.title, "fix the login bug please", "title collapses whitespace and derives from the first user message");
});

test("second list() reuses the index: unchanged files are not re-derived, index not rewritten", () => {
  const { s, dir } = store();
  const a = s.create({ cwd: "/a", model: "m", agent: "build" });
  s.append(a.id, { role: "user", content: "hello" });
  const first = s.list();
  assert.ok(first.length === 1, "index builds on first list");
  const indexPath = join(dir, "index.json");
  assert.ok(statSync(indexPath).isFile(), "index file persisted");
  const indexMtime = statSync(indexPath).mtimeMs;

  const second = s.list();
  assert.deepEqual(second, first);
  assert.equal(statSync(indexPath).mtimeMs, indexMtime, "no changes means no index rewrite");

  // Appending changes the fingerprint: the next list() picks up the new count.
  s.append(a.id, { role: "assistant", content: "hi" });
  const third = s.list();
  assert.equal(third[0]?.messageCount, 2, "changed file is re-derived");
});

test("list() never rewrites session files — legacy metas are derived, not migrated on disk", () => {
  const { s, dir } = store();
  const meta = s.create({ cwd: "/legacy", model: "m", agent: "build" });
  s.append(meta.id, { role: "user", content: "old session" });
  // Strip the v2 fields from the meta line to simulate a pre-migration file.
  const file = join(dir, `${meta.id}.jsonl`);
  const stripped = readFileSync(file, "utf8").replace(/,"prefixHash":"[^"]*"/, "");
  writeFileSync(file, stripped, { encoding: "utf8" });
  const before = readFileSync(file, "utf8");
  utimesSync(file, new Date(), new Date());

  const listed = s.list();
  assert.ok(listed[0]?.prefixHash, "derived meta carries the in-memory backfill");
  assert.equal(readFileSync(file, "utf8"), before, "the session file itself must not be touched by list()");

  // A later full load() still migrates and reports the same message count.
  const loaded = s.load(meta.id);
  assert.equal(loaded?.meta.messageCount, listed[0]?.messageCount);
  assert.equal(loaded?.messages.length, 1);
});

test("latest() prefers the newest session for the cwd, falls back to the overall newest", () => {
  const { s, dir } = store();
  const here = s.create({ cwd: "/here", model: "m", agent: "build" });
  s.append(here.id, { role: "user", content: "workspace session" });
  const elsewhere = s.create({ cwd: "/elsewhere", model: "m", agent: "build" });
  s.append(elsewhere.id, { role: "user", content: "other session" });
  touch(dir, here.id, 5_000);
  touch(dir, elsewhere.id, 1_000);

  assert.equal(s.latest("/here")?.id, here.id, "cwd match wins over recency");
  assert.equal(s.latest("/elsewhere")?.id, elsewhere.id);
  assert.equal(s.latest()?.id, elsewhere.id, "no cwd: newest overall");
  assert.equal(s.latest("/nope")?.id, elsewhere.id, "unknown cwd: newest overall");
});

test("a corrupt index is ignored and rebuilt", () => {
  const { s, dir } = store();
  const a = s.create({ cwd: "/a", model: "m", agent: "build" });
  s.append(a.id, { role: "user", content: "hello" });
  s.list();
  writeFileSync(join(dir, "index.json"), "{not json", { encoding: "utf8" });

  const metas = s.list();
  assert.equal(metas.length, 1);
  assert.equal(metas[0]?.messageCount, 1);
  const rebuilt = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { version: number };
  assert.equal(rebuilt.version, 1, "index rewritten in valid form");
});

test("index drops entries for deleted session files", () => {
  const { s, dir } = store();
  const a = s.create({ cwd: "/a", model: "m", agent: "build" });
  const b = s.create({ cwd: "/b", model: "m", agent: "build" });
  s.list();
  rmSync(join(dir, `${a.id}.jsonl`));
  const metas = s.list();
  assert.deepEqual(
    metas.map((m) => m.id),
    [b.id],
  );
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { entries: Record<string, unknown> };
  assert.ok(!(a.id in index.entries), "stale entry pruned");
});
