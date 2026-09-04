import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkpointIdsFromEventsAfterIndex,
  collectCheckpointIdsInThread,
  inferCheckpointOperation,
} from "../src/checkpoint-events.js";
import type { ThreadEvent } from "../src/types.js";

test("inferCheckpointOperation classifies write/edit/delete", () => {
  assert.equal(inferCheckpointOperation("", "x"), "write");
  assert.equal(inferCheckpointOperation("a", ""), "delete");
  assert.equal(inferCheckpointOperation("a", "b"), "edit");
});

test("checkpointIdsFromEventsAfterIndex collects ids from file and thought events", () => {
  const events: ThreadEvent[] = [
    { kind: "user", text: "hi" },
    { kind: "file", name: "a.ts", subtitle: "a.ts", adds: 1, dels: 0, checkpointId: "cp1" },
    { kind: "thought", label: "Run stopped", checkpointId: "cp1", revertable: true },
    { kind: "file", name: "b.ts", subtitle: "b.ts", adds: 1, dels: 0, checkpointId: "cp2" },
  ];
  assert.deepEqual(checkpointIdsFromEventsAfterIndex(events, 1), ["cp1", "cp2"]);
  assert.deepEqual(checkpointIdsFromEventsAfterIndex(events, 3), ["cp2"]);
  assert.deepEqual(checkpointIdsFromEventsAfterIndex(events, 4), []);
});

test("collectCheckpointIdsInThread gathers all referenced checkpoint ids", () => {
  const events: ThreadEvent[] = [
    { kind: "file", name: "a", subtitle: "a", adds: 0, dels: 0, checkpointId: "cp1" },
    { kind: "thought", label: "Run stopped", checkpointId: "cp2" },
  ];
  assert.deepEqual([...collectCheckpointIdsInThread(events)].sort(), ["cp1", "cp2"]);
});
