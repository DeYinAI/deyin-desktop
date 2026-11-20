import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationRun } from "@deyin/contract";
import { translate, type MessageKey } from "@deyin/host-core/shared";
import { outcomeKey, runFacts } from "../src/automationRun.js";

const t = (key: MessageKey): string => translate("en", key);

function run(patch: Partial<AutomationRun> = {}): AutomationRun {
  return { id: "r", automationId: "a", status: "completed", startedAt: 1_000, finishedAt: 201_000, events: [], ...patch };
}

test("every outcome has its own label", () => {
  const outcomes = ["success", "idle", "blocked", "failed", "unreported"] as const;
  const labels = outcomes.map((o) => t(outcomeKey(o)));
  assert.equal(new Set(labels).size, outcomes.length);
  for (const label of labels) assert.ok(label.length > 0 && !label.startsWith("automations."), `${label} is translated`);
});

test("facts come from the summary, which survives history trimming", () => {
  const facts = runFacts(run({ summary: { steps: 400, toolCalls: {}, toolErrors: 3, durationMs: 200_000 }, events: [] }), t);
  assert.equal(facts, "400 tool calls · 3 failed · 3m 20s");
});

test("a run recorded before summaries existed is counted from the events it kept", () => {
  const facts = runFacts(
    run({
      events: [
        { type: "tool-start", callId: "1", name: "bash", summary: "" },
        { type: "tool-end", callId: "1", name: "bash", summary: "", result: "x", ok: false },
        { type: "tool-start", callId: "2", name: "bash", summary: "" },
        { type: "tool-end", callId: "2", name: "bash", summary: "", result: "x", ok: true },
      ],
    }),
    t,
  );
  assert.equal(facts, "2 tool calls · 1 failed · 3m 20s");
});

test("a run with nothing to count says only how long it took, and a live run says nothing", () => {
  assert.equal(runFacts(run(), t), "3m 20s");
  assert.equal(runFacts(run({ finishedAt: undefined, status: "running" }), t), "");
});
