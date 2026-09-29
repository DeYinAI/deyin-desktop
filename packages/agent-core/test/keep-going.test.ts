import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeEvidenceGate, describeStreamRetry } from "@deyin/host-core/shared";
import { runAgent, type AgentEvent, type AgentRunOptions, type AgentRunResult } from "../src/loop.js";
import { PermissionEngine } from "../src/permissions.js";
import { createBuiltinRegistry } from "../src/tools/index.js";
import type { AgentMessage } from "../src/types.js";
import { startFlakyOpenAI, type WireBehavior, type WireScript } from "./helpers/flaky-openai.js";
import { textResponse, toolCallResponse } from "./helpers/mock-openai.js";

/**
 * "Keep going until the task is done." The loop ends a run when a response has
 * no tool calls, which is right when the model deliberately answers and wrong
 * when the turn was cut short: an empty reply, a promise of work never carried
 * out, an output-token cut-off, a dropped connection. These tests script each
 * of those against a real HTTP server and pin what the loop does about them.
 */

/** Backoffs of a few milliseconds so replay tests run in real time. */
const FAST_RETRY = { maxAttempts: 3, baseDelayMs: 2, maxDelayMs: 5 };

const reply = (text: string): WireBehavior => ({ kind: "events", events: textResponse(text) });
const toolCall = (name: string, args: object = {}): WireBehavior => ({
  kind: "events",
  events: toolCallResponse(`call_${name}`, name, args),
});
/** A response the provider cut off at the output-token limit. */
const cutByLength = (text: string): WireBehavior => ({
  kind: "events",
  events: [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ],
});
/** A stream that just stops: no finish_reason, no [DONE] sentinel. */
const cutOffText = (text: string): WireBehavior => ({
  kind: "events",
  events: [{ choices: [{ delta: { content: text } }] }],
  done: false,
});
const httpError = (status: number): WireBehavior => ({ kind: "http-error", status });

interface Harness {
  result: AgentRunResult;
  messages: AgentMessage[];
  events: AgentEvent[];
  requests: Record<string, unknown>[];
}

async function withRun(
  script: WireScript,
  overrides: Partial<AgentRunOptions> = {},
  check?: (h: Harness) => void | Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-keep-going-"));
  const server = await startFlakyOpenAI(script);
  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "You are a test agent." },
      { role: "user", content: "fix the bug" },
    ];
    const events: AgentEvent[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "test-token",
      model: "test-model",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "allow",
      cwd,
      // Todo/goal reconciliation has its own tests; keep these about continuation.
      todoReconcile: false,
      goalReconcile: false,
      streamRetry: FAST_RETRY,
      onEvent: (event) => events.push(event),
      ...overrides,
    });
    await check?.({ result, messages, events, requests: server.requests });
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

const gates = (events: AgentEvent[]): string[] =>
  events.flatMap((e) => (e.type === "evidence-gate" ? [e.code] : []));
const retries = (events: AgentEvent[]): Extract<AgentEvent, { type: "stream-retry" }>[] =>
  events.flatMap((e) => (e.type === "stream-retry" ? [e] : []));
const userTurns = (messages: AgentMessage[]): string[] =>
  messages.flatMap((m) => (m.role === "user" ? [String(m.content)] : []));

/* Announce-then-stop and empty turns ---------------------------------------- */

test("a turn that announces an action and stops is nudged, and the run carries on", async () => {
  await withRun(
    (i) =>
      i === 0
        ? reply("I found the cause in the loader. Now let me read the config file:")
        : i === 1
          ? toolCall("todo_read")
          : reply("Everything is fixed."),
    {},
    ({ result, messages, events, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(result.finalText, "Everything is fixed.");
      assert.equal(requests.length, 3, "announce, tool call, final answer");

      const nudge = userTurns(messages).find((t) => t.startsWith("[continue]"));
      assert.ok(nudge, "the continue nudge must be on the transcript");
      assert.match(nudge, /let me read the config file/i, "the nudge quotes what the model promised");
      assert.deepEqual(gates(events), ["unfinished_turn"]);
      assert.equal(result.summary?.continuationNudges, 1);
    },
  );
});

test("an empty response is nudged instead of ending the run with nothing done", async () => {
  await withRun(
    (i) => (i === 0 ? reply("") : reply("Updated 3 files and the tests pass.")),
    {},
    ({ result, messages, events, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(result.finalText, "Updated 3 files and the tests pass.");
      assert.equal(requests.length, 2);
      assert.match(userTurns(messages).find((t) => t.startsWith("[continue]")) ?? "", /empty/);
      assert.deepEqual(gates(events), ["empty_response"]);
    },
  );
});

test("a model that keeps stalling is nudged twice, then the turn is allowed to end", async () => {
  await withRun(
    () => reply("Let me check the file:"),
    {},
    ({ result, events, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(requests.length, 3, "the original answer plus two nudged retries");
      assert.deepEqual(gates(events), ["unfinished_turn", "unfinished_turn"]);
    },
  );
});

test("the stall limit is a streak: a tool call in between re-arms it", async () => {
  // announce (nudge 1) -> tool call -> announce (nudge 1 again) -> announce (nudge 2) -> announce (limit)
  await withRun(
    (i) => (i === 1 ? toolCall("todo_read") : reply("Now let me run the tests:")),
    {},
    ({ result, events, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(requests.length, 5);
      assert.equal(gates(events).length, 3, "3 nudges in total, never more than 2 in a row");
    },
  );
});

test("genuine final answers and questions to the user are never nudged", async () => {
  const finals = [
    "The bug was an off-by-one in the pager. I fixed it and the tests pass.",
    "I've made the change. Want me to also add a regression test?",
    "There are two ways to do this. Which one would you prefer?",
    "All done — let me know if you want anything else.",
    "```ts\nconst x = 1;\n```",
  ];
  for (const text of finals) {
    await withRun(
      () => reply(text),
      {},
      ({ result, events, requests }) => {
        assert.equal(result.reason, "completed", text);
        assert.equal(requests.length, 1, `must not nudge: ${text}`);
        assert.deepEqual(gates(events), []);
      },
    );
  }
});

test("continuationNudges: false restores the old turn end", async () => {
  await withRun(
    () => reply("Let me check the file:"),
    { continuationNudges: false },
    ({ result, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(requests.length, 1);
    },
  );
});

test("no nudge on the last permitted step: the run must not turn into a max-steps stop", async () => {
  await withRun(
    (i) => (i === 0 ? toolCall("todo_read") : reply("Now let me run the tests:")),
    { maxSteps: 2 },
    ({ result, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(requests.length, 2, "there is no step left to act on a nudge");
    },
  );
});

test("with no tools to call there is nothing to nudge the model towards", async () => {
  await withRun(
    () => reply("Let me check the file:"),
    { tools: createBuiltinRegistry().filtered([]) },
    ({ result, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(requests.length, 1);
    },
  );
});

/* Output-token cut-offs ----------------------------------------------------- */

test("a reply cut off by the output limit is resumed rather than returned half-written", async () => {
  await withRun(
    (i) => (i === 0 ? cutByLength("First half of the explanation, which stops mid") : reply(" sentence, and here is the rest.")),
    {},
    ({ result, messages, events, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(requests.length, 2);
      assert.equal(result.finalText, " sentence, and here is the rest.");
      assert.ok(
        userTurns(messages).some((t) => t.startsWith("[output limit]")),
        "the resume instruction must be on the transcript",
      );
      // The partial answer stays in the transcript so the model continues from it.
      assert.ok(messages.some((m) => m.role === "assistant" && String(m.content).includes("stops mid")));
      assert.deepEqual(gates(events), ["output_truncated"]);
    },
  );
});

test("output-limit resumes are bounded so a model that never finishes cannot loop forever", async () => {
  await withRun(
    () => cutByLength("more and more text without an end"),
    {},
    ({ result, events, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(requests.length, 4, "the original plus three resumes");
      assert.equal(gates(events).length, 3);
    },
  );
});

test("a tool call cut off by the output limit gets an explanation, not a generic JSON error", async () => {
  const cut: WireBehavior = {
    kind: "events",
    events: [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_w", type: "function", function: { name: "write", arguments: '{"path":"big.txt","content":"abc' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ],
  };
  await withRun(
    (i) => (i === 0 ? cut : reply("Split it into smaller writes and finished.")),
    {},
    ({ result, messages }) => {
      assert.equal(result.reason, "completed");
      const toolMessage = messages.find((m) => m.role === "tool");
      assert.ok(toolMessage, "the cut-off call still needs its paired tool result");
      assert.match(String(toolMessage.content), /output token limit/);
      assert.doesNotMatch(String(toolMessage.content), /not valid JSON/);
    },
  );
});

test("an ordinary malformed tool call still gets the plain JSON error", async () => {
  const malformed: WireBehavior = {
    kind: "events",
    events: [
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "call_w", type: "function", function: { name: "write", arguments: "{oops" } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ],
  };
  await withRun(
    (i) => (i === 0 ? malformed : reply("Fixed the arguments.")),
    {},
    ({ messages }) => {
      const toolMessage = messages.find((m) => m.role === "tool");
      assert.match(String(toolMessage?.content), /not valid JSON/);
    },
  );
});

/* Transient failures -------------------------------------------------------- */

test("a transient provider error is replayed instead of ending the run", async () => {
  await withRun(
    // 529 (overloaded) is retryable but is not one of the statuses the HTTP layer already retries itself.
    (i) => (i === 0 ? httpError(529) : reply("Recovered and finished.")),
    {},
    ({ result, events, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(result.finalText, "Recovered and finished.");
      assert.equal(requests.length, 2);
      const [retry, ...rest] = retries(events);
      assert.equal(rest.length, 0);
      assert.equal(retry?.attempt, 1);
      assert.equal(retry?.maxAttempts, FAST_RETRY.maxAttempts);
      assert.match(retry?.reason ?? "", /529/);
      assert.equal(result.summary?.streamRetries, 1);
    },
  );
});

test("replays are bounded, and the original error is what finally surfaces", async () => {
  const events: AgentEvent[] = [];
  await assert.rejects(
    withRun(() => httpError(529), { streamRetry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 }, onEvent: (e) => events.push(e) }),
    /\(529\)/,
  );
  assert.equal(retries(events).length, 2);
});

test("errors that replaying cannot fix surface immediately", async () => {
  for (const status of [400, 401, 402, 403, 404]) {
    const events: AgentEvent[] = [];
    let requests = 0;
    await assert.rejects(
      withRun(
        () => {
          requests += 1;
          return httpError(status);
        },
        { onEvent: (e) => events.push(e) },
      ),
      new RegExp(`\\(${status}\\)`),
    );
    assert.equal(requests, 1, `HTTP ${status} must not be retried`);
    assert.equal(retries(events).length, 0);
  }
});

test("a request that fetch itself refuses (blocked port) surfaces at once instead of being replayed", async () => {
  // Port 9 is on fetch's blocked list: it throws TypeError("fetch failed") with a
  // codeless cause ("bad port") without touching the network. A hard-down provider
  // must not cost the user a minute of retries, and neither must a bad base URL.
  const events: AgentEvent[] = [];
  // If this ever regresses the run would sit in 10s backoffs; the abort turns that
  // into a prompt "missing rejection" failure instead of a minute-long hang.
  const controller = new AbortController();
  const bail = setTimeout(() => controller.abort(), 3_000);
  try {
    await assert.rejects(
      withRun(
        () => reply("never reached"),
        {
          apiBaseUrl: "http://127.0.0.1:9/v1",
          streamRetry: { maxAttempts: 5, baseDelayMs: 10_000, maxDelayMs: 20_000 },
          signal: controller.signal,
          onEvent: (e) => events.push(e),
        },
      ),
      /fetch failed/,
    );
  } finally {
    clearTimeout(bail);
  }
  assert.equal(retries(events).length, 0, "nothing to replay: the request never left the process");
});

test("a connection dropped mid-response is replayed and the partial text is discarded", async () => {
  await withRun(
    (i) =>
      i === 0
        ? { kind: "drop", events: [{ choices: [{ delta: { content: "I was in the middle of expla" } }] }] }
        : reply("Here is the complete explanation."),
    {},
    ({ result, messages, events, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(requests.length, 2);
      assert.equal(retries(events).length, 1);
      const assistants = messages.filter((m) => m.role === "assistant");
      assert.equal(assistants.length, 1, "the dropped attempt never reaches the transcript");
      assert.equal(assistants[0]?.content, "Here is the complete explanation.");
    },
  );
});

test("an error frame inside a 200 stream is replayed when transient, surfaced when not", async () => {
  const frame = (type: string): WireBehavior => ({
    kind: "events",
    events: [{ choices: [{ delta: { content: "par" } }] }, { error: { type, message: `mock ${type}` } }],
  });
  await withRun(
    (i) => (i === 0 ? frame("server_error") : reply("Done after the server error.")),
    {},
    ({ result, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(requests.length, 2);
    },
  );
  // Surfacing the same message after retries would satisfy the pattern alone, so
  // count the requests: a permanent error must be tried exactly once.
  let permanentAttempts = 0;
  await assert.rejects(
    withRun(() => {
      permanentAttempts += 1;
      return frame("invalid_request_error");
    }, {}),
    /mock invalid_request_error/,
  );
  assert.equal(permanentAttempts, 1, "a permanent error frame must not be replayed");
});

test("a stream that ends with no end marker is replayed, not taken as a finished answer", async () => {
  await withRun(
    (i) => (i === 0 ? cutOffText("The answer is") : reply("The answer is 42.")),
    {},
    ({ result, requests, events }) => {
      assert.equal(result.reason, "completed");
      assert.equal(result.finalText, "The answer is 42.");
      assert.equal(requests.length, 2);
      assert.equal(retries(events).length, 1);
    },
  );
});

test("a provider that never sends an end marker is replayed twice, then taken as it comes", async () => {
  const cutToolCall: WireBehavior = {
    kind: "events",
    events: [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_t", type: "function", function: { name: "todo_read", arguments: "{}" } }] } }] },
    ],
    done: false,
  };
  await withRun(
    (i) => (i <= 2 ? cutToolCall : cutOffText("All done.")),
    {},
    ({ result, requests, events }) => {
      assert.equal(result.reason, "completed");
      assert.equal(result.finalText, "All done.");
      // Step 1 replayed twice (3 requests); once accepted, step 2 is taken at face value (1 request).
      assert.equal(requests.length, 4);
      assert.equal(retries(events).length, 2);
    },
  );
});

test("each cut-off stream is judged on its own: a clean replay does not switch tolerance on", async () => {
  await withRun(
    (i) => {
      switch (i) {
        case 0:
          return {
            kind: "events",
            events: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_t", type: "function", function: { name: "todo_read", arguments: "{}" } }] } }] }],
            done: false,
          };
        case 1:
          return toolCall("todo_read");
        case 2:
          return cutOffText("Working on");
        default:
          return reply("Finished cleanly.");
      }
    },
    {},
    ({ result, requests, events }) => {
      assert.equal(result.reason, "completed");
      assert.equal(result.finalText, "Finished cleanly.");
      assert.equal(requests.length, 4);
      assert.equal(retries(events).length, 2, "both blips were replayed");
    },
  );
});

test("a reply that promises tool calls but delivers none is replayed", async () => {
  const lost: WireBehavior = {
    kind: "events",
    events: [{ choices: [{ delta: { content: "Checking" } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }],
  };
  await withRun(
    (i) => (i === 0 ? lost : reply("All good.")),
    {},
    ({ result, messages, requests, events }) => {
      assert.equal(result.reason, "completed");
      assert.equal(requests.length, 2);
      assert.match(retries(events)[0]?.reason ?? "", /no tool call arrived/);
      assert.equal(messages.filter((m) => m.role === "assistant").length, 1);
    },
  );
});

test("lost-tool-call replays are bounded", async () => {
  const lost: WireBehavior = {
    kind: "events",
    events: [{ choices: [{ delta: { content: "Checking" } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }],
  };
  await withRun(
    () => lost,
    {},
    ({ result, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(requests.length, 3, "the original plus two replays");
    },
  );
});

test("aborting while waiting to retry ends the run promptly as aborted", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  const startedAt = Date.now();
  await withRun(
    () => httpError(529),
    { signal: controller.signal, streamRetry: { maxAttempts: 5, baseDelayMs: 10_000, maxDelayMs: 20_000 } },
    ({ result, requests }) => {
      assert.equal(result.reason, "aborted");
      assert.equal(requests.length, 1);
    },
  );
  assert.ok(Date.now() - startedAt < 5_000, "the backoff sleep must not outlive the abort");
});

test("the step-limit warning is added once even when its step is replayed", async () => {
  await withRun(
    (i) => (i === 0 ? toolCall("todo_read") : i === 1 ? httpError(529) : reply("Wrapped up.")),
    { maxSteps: 2 },
    ({ result, messages, requests }) => {
      assert.equal(result.reason, "completed");
      assert.equal(requests.length, 3);
      const warnings = userTurns(messages).filter((t) => t.startsWith("[step limit warning]"));
      assert.equal(warnings.length, 1);
    },
  );
});

/* What the person sees ------------------------------------------------------ */

test("the gates the loop emits to keep the model going are worded as notices, not delivery-gate failures", async () => {
  const seen = new Set<string>();
  const scenarios: WireScript[] = [
    (i) => (i === 0 ? reply("Now let me read the config file:") : reply("The config is fine.")),
    (i) => (i === 0 ? reply("") : reply("The config is fine.")),
    (i) => (i === 0 ? cutByLength("The config file has three sec") : reply("tions, all valid.")),
  ];
  for (const script of scenarios) {
    await withRun(script, {}, ({ events }) => {
      for (const event of events) {
        if (event.type !== "evidence-gate") continue;
        seen.add(event.code);
        const notice = describeEvidenceGate(event.code, event.message);
        assert.equal(notice.tone, "notice", `${event.code} must not render as a delivery-gate failure`);
        assert.ok(!/delivery gate/i.test(notice.text), `${event.code} rendered as: ${notice.text}`);
      }
    });
  }
  assert.deepEqual([...seen].sort(), ["empty_response", "output_truncated", "unfinished_turn"]);
});

test("a replayed step is announced as a stream-retry the renderers can word", async () => {
  await withRun(
    (i) => (i === 0 ? httpError(529) : reply("All good.")),
    {},
    ({ result, events }) => {
      assert.equal(result.reason, "completed");
      const [retry] = retries(events);
      assert.ok(retry, "a stream-retry event must precede the replay");
      const line = describeStreamRetry(retry);
      assert.match(line, /^.+ — retrying in \d+s \(1\/3\)$/);
    },
  );
});
