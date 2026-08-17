import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionStore } from "../src/session.js";
import { SESSION_SCHEMA_VERSION } from "../src/migration/session-v2.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function store(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), "deyin-sessionlog-"));
  dirs.push(dir);
  return new SessionStore(dir);
}

test("create journals a session-created lifecycle event; replay mixes messages and facts", () => {
  const s = store();
  const meta = s.create({ cwd: "/tmp", model: "GLM-5.2", agent: "build" });
  s.append(meta.id, { role: "user", content: "hello" });
  s.appendEvent(meta.id, { kind: "title-set", title: "Greeting" });
  s.append(meta.id, { role: "assistant", content: "hi" });

  const events = s.events(meta.id);
  assert.equal(events[0]?.type, "lifecycle");
  assert.equal(events[0]?.type === "lifecycle" && events[0].event.kind, "session-created");
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2, 3, 4],
    "seq is 1-based over non-meta records, append order",
  );
  // Derived transcript equals the message events (the spine derives sessions).
  const loaded = s.load(meta.id);
  assert.deepEqual(
    loaded?.messages,
    [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
    "lifecycle records must not leak into the transcript",
  );
});

test("full fork replays to the same transcript; source log untouched", () => {
  const s = store();
  const meta = s.create({ cwd: "/repo", model: "m", agent: "build" });
  s.append(meta.id, { role: "user", content: "one" });
  s.append(meta.id, { role: "assistant", content: "two" });
  // First load settles the one-time v2 meta upgrade (store-wide migration,
  // not fork behavior); capture the settled log to pin the fork guarantee.
  s.load(meta.id);
  const sourceRaw = readFileSync(join(dirs.at(-1)!, `${meta.id}.jsonl`), "utf8");

  const forkMeta = s.fork(meta.id);
  assert.ok(forkMeta);
  assert.notEqual(forkMeta!.id, meta.id);
  assert.equal(forkMeta!.forkedFrom, meta.id, "meta carries fork provenance");
  assert.equal(forkMeta!.cwd, "/repo");
  const forkLoaded = s.load(forkMeta!.id);
  assert.deepEqual(
    forkLoaded?.messages,
    [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ],
    "fork replays to the source transcript",
  );
  const forkEvents = s.events(forkMeta!.id);
  const forked = forkEvents.at(-1);
  assert.equal(forked?.type === "lifecycle" && forked.event.kind, "forked");

  assert.equal(
    readFileSync(join(dirs.at(-1)!, `${meta.id}.jsonl`), "utf8"),
    sourceRaw,
    "fork must never rewrite the settled source log",
  );
});

test("partial fork at a seq copies exactly that prefix", () => {
  const s = store();
  const meta = s.create({ cwd: "/w", model: "m", agent: "plan" });
  // seq 1 = session-created lifecycle, then three messages (seq 2..4).
  s.append(meta.id, { role: "user", content: "a" });
  s.append(meta.id, { role: "assistant", content: "b" });
  s.append(meta.id, { role: "user", content: "c" });

  const forkMeta = s.fork(meta.id, { atSeq: 3 });
  assert.ok(forkMeta);
  assert.deepEqual(
    s.load(forkMeta!.id)?.messages,
    [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ],
    "fork at seq 3 keeps records 1..3 (lifecycle + two messages)",
  );
  // Appends to the fork diverge without touching the source.
  s.append(forkMeta!.id, { role: "user", content: "divergent" });
  assert.equal(s.load(meta.id)?.messages.length, 3);
  assert.equal(s.load(forkMeta!.id)?.messages.length, 3);
});

test("fork and replay survive legacy v1/v2 logs written before lifecycle events existed", () => {
  const s = store();
  const meta = s.create({ cwd: "/legacy", model: "old-model", agent: "build" });
  // Rewrite the file as a legacy log: v1 meta + bare message records, no lifecycle.
  const file = join(dirs.at(-1)!, `${meta.id}.jsonl`);
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "meta",
        meta: { id: meta.id, title: "", createdAt: meta.createdAt, cwd: "/legacy", model: "old-model", agent: "build" },
      }),
      JSON.stringify({ type: "message", message: { role: "user", content: "legacy one" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "legacy two" } }),
    ].join("\n") + "\n",
  );

  const events = s.events(meta.id);
  assert.equal(events.length, 2, "legacy message logs replay as events");
  assert.equal(events[0]?.seq, 1);

  const loaded = s.load(meta.id);
  assert.equal(loaded?.meta.schemaVersion, SESSION_SCHEMA_VERSION, "v1 meta upgrades on load");

  const forkMeta = s.fork(meta.id);
  assert.ok(forkMeta);
  assert.deepEqual(
    s.load(forkMeta!.id)?.messages.map((m) => m.content),
    ["legacy one", "legacy two"],
    "fork of a legacy log replays correctly",
  );
});

test("torn tail stops replay at the last complete record", () => {
  const s = store();
  const meta = s.create({ cwd: "/t", model: "m", agent: "build" });
  s.append(meta.id, { role: "user", content: "ok" });
  const file = join(dirs.at(-1)!, `${meta.id}.jsonl`);
  appendFileSync(file, '{"type":"message","message":{"role":"user","content":"tor', "utf8");
  const events = s.events(meta.id);
  const complete = events.filter((e) => e.type === "message");
  assert.equal(complete.length, 1);
  assert.equal(s.load(meta.id)?.messages.length, 1);
});

test("appends after a crash-torn tail continue the log (append-only recovery)", () => {
  const s = store();
  const meta = s.create({ cwd: "/t2", model: "m", agent: "build" });
  const file = join(dirs.at(-1)!, `${meta.id}.jsonl`);
  appendFileSync(file, '{"type":"message","message":{"role":"tool","content":"partial', "utf8");
  s.append(meta.id, { role: "user", content: "after crash" });
  const events = s.events(meta.id);
  // The torn line is skipped; the well-formed record after it still replays.
  assert.ok(events.some((e) => e.type === "message" && e.message.content === "after crash"));
});
