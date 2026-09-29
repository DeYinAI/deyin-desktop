import assert from "node:assert/strict";
import test from "node:test";

if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(Date.now()), 0) as unknown as number;
  };
}

import {
  __testDispatch,
  __testFlushRaf,
  __testGetThreadState,
  __testResetAgentStore,
  agentStateStore,
  type AgentSideEffect,
} from "../src/hooks/useAgentState.js";

const RETRY = { type: "stream-retry", attempt: 2, maxAttempts: 5, reason: "The provider returned HTTP 503", delayMs: 3000 } as const;

test("stream-retry drops the failed attempt's partial text so the replay does not show it twice", async () => {
  __testResetAgentStore();
  const threadId = "retry-text";
  agentStateStore.startRun(threadId, "agent");

  __testDispatch({ threadId, event: { type: "text-delta", delta: "Let me chec" } });
  await __testFlushRaf();
  assert.equal(__testGetThreadState(threadId).streamText, "Let me chec");

  __testDispatch({ threadId, event: RETRY });
  assert.equal(__testGetThreadState(threadId).streamText, "", "the void attempt's text must be cleared at once");

  __testDispatch({ threadId, event: { type: "text-delta", delta: "Let me check the file." } });
  await __testFlushRaf();
  assert.equal(__testGetThreadState(threadId).streamText, "Let me check the file.");
});

test("stream-retry also clears reasoning that was still streaming", async () => {
  __testResetAgentStore();
  const threadId = "retry-reasoning";
  agentStateStore.startRun(threadId, "agent");

  __testDispatch({ threadId, event: { type: "reasoning-delta", delta: "Thinking about the" } });
  await __testFlushRaf();
  assert.equal(__testGetThreadState(threadId).streamReasoning, "Thinking about the");

  __testDispatch({ threadId, event: RETRY });
  assert.equal(__testGetThreadState(threadId).streamReasoning, "");

  // The replay's reasoning starts from scratch instead of appending to the void attempt's.
  __testDispatch({ threadId, event: { type: "reasoning-delta", delta: "Second try" } });
  await __testFlushRaf();
  assert.equal(__testGetThreadState(threadId).streamReasoning, "Second try");
});

test("a frame flush queued before the retry cannot bring the discarded text back", async () => {
  __testResetAgentStore();
  const threadId = "retry-raf-race";
  agentStateStore.startRun(threadId, "agent");

  // The delta schedules an animation-frame flush; the retry lands before it runs.
  __testDispatch({ threadId, event: { type: "text-delta", delta: "stale partial" } });
  __testDispatch({ threadId, event: RETRY });
  await __testFlushRaf();

  assert.equal(__testGetThreadState(threadId).streamText, "");
});

test("stream-retry leaves a timeline line and status, and does not end the run", () => {
  __testResetAgentStore();
  const threadId = "retry-line";
  agentStateStore.startRun(threadId, "agent");

  __testDispatch({ threadId, event: RETRY });

  const snap = __testGetThreadState(threadId);
  assert.equal(snap.running, true, "a retry is not the end of the run");
  const last = snap.runEvents.at(-1);
  assert.ok(last && last.kind === "thought");
  assert.equal(last.label, "The provider returned HTTP 503 — retrying in 3s (2/5)");
  assert.equal(snap.status.retryCount, 2);
  assert.equal(snap.status.maxRetries, 5);
  assert.match(snap.status.label, /Reconnecting \(2\/5\)/);
});

test("after a retry the final answer is folded exactly once", async () => {
  __testResetAgentStore();
  const threadId = "retry-fold";
  const effects: AgentSideEffect[] = [];
  const off = agentStateStore.onSideEffect((effect) => effects.push(effect));

  agentStateStore.startRun(threadId, "agent");
  __testDispatch({ threadId, event: { type: "text-delta", delta: "Partial answ" } });
  __testDispatch({ threadId, event: RETRY });
  __testDispatch({ threadId, event: { type: "text-delta", delta: "Complete answer." } });
  await __testFlushRaf();
  __testDispatch({ threadId, event: { type: "done", reason: "completed", finalText: "Complete answer." } });
  off();

  const complete = effects.find((e) => e.type === "run-complete");
  assert.ok(complete && complete.type === "run-complete");
  const assistantTexts = complete.fold.events.flatMap((e) => (e.kind === "assistant" ? [e.text] : []));
  assert.deepEqual(assistantTexts, ["Complete answer."]);
  assert.ok(
    complete.fold.events.some((e) => e.kind === "thought" && /retrying in 3s/.test(e.label)),
    "the retry stays visible in the folded transcript",
  );
});
