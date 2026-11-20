import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationInfo, LearnedRevision } from "@deyin/contract";
import { translate, type MessageKey } from "@deyin/host-core/shared";
import { healingView, MAX_REVISIONS_SHOWN, revisionStatusKey } from "../src/automationHealing.js";

const t = (key: MessageKey): string => translate("en", key);

function task(patch: Partial<AutomationInfo> = {}): AutomationInfo {
  return {
    id: "a",
    name: "X",
    enabled: true,
    payload: { kind: "prompt", prompt: "p" },
    trigger: { kind: "manual" },
    target: { kind: "local", workspacePath: "/w" },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function revision(patch: Partial<LearnedRevision> = {}): LearnedRevision {
  return {
    id: "v1",
    at: 100,
    runId: "r",
    signature: "failed:chrome_click:not-found",
    rationale: "The composer was not ready.",
    added: ["Wait for the composer."],
    removed: [],
    previousRules: [],
    baselineFailures: 1,
    status: "probation",
    ...patch,
  };
}

test("healing is on unless it was turned off, and an automation that never healed has nothing to list", () => {
  assert.deepEqual(healingView(task()), { enabled: true, rules: [], revisions: [], hasHistory: false });
  assert.equal(healingView(task({ autoHeal: false })).enabled, false);
  assert.equal(healingView(task({ autoHeal: true })).enabled, true);
});

test("each status of a patch is told apart, in words", () => {
  const labels = (["probation", "kept", "reverted"] as const).map((status) => t(revisionStatusKey(status)));
  assert.equal(new Set(labels).size, 3);
  for (const label of labels) assert.ok(label.length > 0 && !label.startsWith("automations."), `${label} is translated`);
});

test("patches are listed newest first, and only those still in effect can be undone", () => {
  const view = healingView(
    task({
      learnedRules: ["Wait for the composer."],
      learnedRevisions: [
        revision({ id: "old", at: 100, status: "kept" }),
        revision({ id: "mid", at: 200, status: "reverted", note: "Reverted by you." }),
        revision({ id: "new", at: 300, status: "probation" }),
      ],
    }),
  );
  assert.deepEqual(view.revisions.map((r) => [r.id, r.canRevert]), [
    ["new", true],
    ["mid", false],
    ["old", true],
  ]);
  assert.equal(view.revisions[1]?.note, "Reverted by you.");
  assert.equal("note" in (view.revisions[0] ?? {}), false);
  assert.equal(view.hasHistory, true);
});

test("rules without any recorded patch are still shown, and a long history is cut to the recent part", () => {
  assert.equal(healingView(task({ learnedRules: ["One."] })).hasHistory, true);
  const many = Array.from({ length: MAX_REVISIONS_SHOWN + 5 }, (_, i) => revision({ id: `v${i}`, at: i }));
  const view = healingView(task({ learnedRevisions: many }));
  assert.equal(view.revisions.length, MAX_REVISIONS_SHOWN);
  assert.equal(view.revisions[0]?.id, `v${MAX_REVISIONS_SHOWN + 4}`);
});

test("the view does not reorder or alter what is stored", () => {
  const stored = [revision({ id: "a", at: 1 }), revision({ id: "b", at: 2 })];
  healingView(task({ learnedRevisions: stored }));
  assert.deepEqual(stored.map((r) => r.id), ["a", "b"]);
});
