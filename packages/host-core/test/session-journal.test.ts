import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionEventJournal } from "../src/session-journal.js";
import type { AgentUiEvent } from "../src/types.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function journal(): SessionEventJournal {
  const dir = mkdtempSync(join(tmpdir(), "deyin-journal-"));
  dirs.push(dir);
  return new SessionEventJournal(dir);
}

test("append is monotonic and read replays in order", async () => {
  const j = journal();
  await j.append("s1", { type: "text-delta", delta: "Hello " });
  await j.append("s1", { type: "text-delta", delta: "world" });
  await j.append("s1", { type: "done", reason: "completed", finalText: "Hello world" });
  const entries = await j.read("s1");
  assert.deepEqual(entries.map((e) => e.seq), [1, 2, 3]);
  assert.equal(entries[1]?.event.type, "text-delta");
});

test("a fresh SessionEventJournal instance continues the sequence after reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-journal-"));
  dirs.push(dir);
  const first = new SessionEventJournal(dir);
  await first.append("s1", { type: "text-delta", delta: "one" });
  const second = new SessionEventJournal(dir);
  await second.read("s1");
  const entry = await second.append("s1", { type: "text-delta", delta: "two" });
  assert.equal(entry.seq, 2, "seq must continue from the journal, not restart");
});

test("torn tail lines stop the replay at the last complete entry", async () => {
  const j = journal();
  await j.append("s1", { type: "text-delta", delta: "ok" });
  // Simulate a crash mid-write: half a JSON line.
  const file = join((j as unknown as { journalDir: string }).journalDir, "s1.jsonl");
  writeFileSync(file, '{"seq":2,"ts":1,"event":{"type":"text-del', { flag: "a" });
  const entries = await j.read("s1");
  assert.equal(entries.length, 1);
});

test("transcript folds deltas into assistant turns and records stop reasons", async () => {
  const j = journal();
  const events: AgentUiEvent[] = [
    { type: "text-delta", delta: "Let me check. " },
    { type: "tool-start", callId: "c1", name: "read", summary: "read file" },
    { type: "text-delta", delta: "Done." },
    { type: "done", reason: "max-steps", finalText: "" },
  ];
  for (const event of events) await j.append("t1", event);
  const transcript = SessionEventJournal.transcript(await j.read("t1"));
  assert.deepEqual(transcript, [
    { role: "assistant", content: "Let me check. Done." },
    { role: "system", content: "run max-steps" },
  ]);
});

test("sessions() lists journaled ids only", async () => {
  const j = journal();
  await j.append("a", { type: "text-delta", delta: "x" });
  await j.append("b", { type: "done", reason: "completed", finalText: "" });
  assert.deepEqual((await j.sessions()).sort(), ["a", "b"]);
});
