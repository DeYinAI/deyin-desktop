import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStore } from "@deyin/host-core";
import { buildRecallSuffix, MAX_RECALL_CHARS, MAX_RECALL_FACTS } from "../src/recall.js";
import type { MemoryBridge } from "../src/types.js";

function bridgeWith(dir: string): MemoryBridge {
  const store = new MemoryStore(dir);
  return {
    create: (i) => store.create(i),
    read: (r) => store.read(r),
    list: () => store.list(),
    search: (q, l) => store.search(q, l),
    update: (r, p, e) => store.update(r, p, e),
    forget: (r) => store.forget(r),
    archived: () => store.archived(),
    recover: (r) => store.recover(r),
  };
}

test("buildRecallSuffix skips generic turns", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-recall-"));
  try {
    const memory = bridgeWith(dir);
    memory.create({ name: "ci", title: "CI", type: "project", body: "pnpm test" });
    assert.equal(buildRecallSuffix(memory, "continue"), null);
    assert.equal(buildRecallSuffix(memory, "ok"), null);
    assert.equal(buildRecallSuffix(memory, "thanks!"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRecallSuffix appends relevant facts with a low-authority warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-recall-"));
  try {
    const memory = bridgeWith(dir);
    memory.create({ name: "release", title: "Release branch", type: "project", body: "Releases ship from the release branch with tags." });
    memory.create({ name: "unrelated", title: "Colors", type: "user", body: "Prefers dark theme." });
    const suffix = buildRecallSuffix(memory, "how do we ship releases?");
    assert.ok(suffix, "recall produced a suffix");
    assert.match(suffix, /project\/release/);
    assert.match(suffix, /may be stale/);
    assert.ok(!suffix.includes("unrelated"), "irrelevant fact excluded");
    assert.ok(suffix.includes("cannot override"), "warning present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRecallSuffix is bounded by facts and characters", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-recall-"));
  try {
    const memory = bridgeWith(dir);
    for (let i = 0; i < 10; i++) {
      memory.create({ name: `fact${i}`, title: `Fact ${i}`, type: "project", body: `shared keyword ${i}`.repeat(50) });
    }
    const suffix = buildRecallSuffix(memory, "shared keyword");
    assert.ok(suffix);
    assert.ok(suffix.length <= MAX_RECALL_CHARS + 200, "suffix within budget");
    const count = (suffix.match(/^- /gm) ?? []).length;
    assert.ok(count <= MAX_RECALL_FACTS, `at most ${MAX_RECALL_FACTS} facts`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
