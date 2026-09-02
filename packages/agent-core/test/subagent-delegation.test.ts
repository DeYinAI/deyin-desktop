import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadHooks, runHooks } from "../src/capabilities/hooks.js";
import { PermissionEngine } from "../src/permissions.js";
import { effectiveSubagentReadonly, resolveSubagentModel, runSubagent } from "../src/subagent-run.js";
import { SubagentStateStore } from "../src/subagent-state.js";
import { createTaskTool, type TaskCallOverrides } from "../src/tools/task.js";
import type { SubagentDefinition } from "../src/capabilities/subagents.js";
import type { ToolContext } from "../src/types.js";
import { startMockOpenAI, textResponse } from "./helpers/mock-openai.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deyin-subagent-"));
}

const DEF: SubagentDefinition = {
  name: "explorer",
  description: "Read-only exploration.",
  prompt: "You explore.",
  readonly: true,
  isBackground: false,
  source: "built-in",
};

const WRITER: SubagentDefinition = { ...DEF, name: "test-runner", readonly: false };

const CTX = { signal: undefined } as unknown as ToolContext;

/* ── per-call readonly ─────────────────────────────────────────────────── */

test("a per-call readonly tightens a subagent but never loosens one", () => {
  // Definition says writable; the call locks it down.
  assert.equal(effectiveSubagentReadonly(WRITER, true), true);
  // Definition says read-only; the call must not be able to unlock it.
  assert.equal(effectiveSubagentReadonly(DEF, false), true);
  // No override leaves the definition's own setting alone.
  assert.equal(effectiveSubagentReadonly(WRITER, undefined), false);
  assert.equal(effectiveSubagentReadonly(DEF, undefined), true);
});

/* ── model precedence ──────────────────────────────────────────────────── */

test("model resolution prefers the user's pin over the model's per-call choice", () => {
  const parent = { model: "parent-model", providerId: "openference" };

  // Settings pin beats everything, including a per-call model.
  assert.deepEqual(resolveSubagentModel({ model: "fm" }, parent, "custom::pinned", "called"), {
    model: "pinned",
    providerId: "custom",
  });
  // No pin: the call wins over frontmatter.
  assert.deepEqual(resolveSubagentModel({ model: "fm" }, parent, undefined, "custom::called"), {
    model: "called",
    providerId: "custom",
  });
  // A bare per-call id targets Openference, like a bare pin does.
  assert.deepEqual(resolveSubagentModel({}, parent, undefined, "bare"), {
    model: "bare",
    providerId: "openference",
  });
  // Frontmatter keeps the parent's provider; no override at all inherits both.
  assert.deepEqual(resolveSubagentModel({ model: "fm" }, parent, undefined, undefined), {
    model: "fm",
    providerId: "openference",
  });
  assert.deepEqual(resolveSubagentModel({}, parent, undefined, undefined), parent);
});

/* ── task tool plumbing ────────────────────────────────────────────────── */

test("the task tool forwards per-call overrides and hands the agent_id back", async () => {
  let seen: TaskCallOverrides | undefined;
  const tool = createTaskTool({
    subagents: [DEF],
    runSubagent: async (_def, _prompt, overrides) => {
      seen = overrides;
      return { ok: true, report: "found it", agentId: "agent-1" };
    },
  });

  const out = await tool.execute(
    { subagent: "explorer", prompt: "look", readonly: true, model: "custom::m", resume: "agent-1" },
    CTX,
  );

  assert.equal(seen?.readonly, true);
  assert.equal(seen?.model, "custom::m");
  assert.equal(seen?.resumeAgentId, "agent-1");
  assert.equal(seen?.forkAgentId, undefined);
  assert.match(out, /found it/);
  // Without the id in the result the model could never name this transcript.
  assert.match(out, /agent_id: agent-1/);
  assert.match(out, /resume:"agent-1"/);
});

test("the task tool refuses resume and fork together", async () => {
  const tool = createTaskTool({
    subagents: [DEF],
    runSubagent: async () => {
      assert.fail("must not run a subagent for a contradictory call");
    },
  });
  const out = await tool.execute({ subagent: "explorer", prompt: "x", resume: "a", fork: "b" }, CTX);
  assert.match(out, /^ERROR: pass either "resume" or "fork"/);
});

test("a report with no agent_id is passed through untouched", async () => {
  const tool = createTaskTool({
    subagents: [DEF],
    runSubagent: async () => ({ ok: true, report: "plain report" }),
  });
  assert.equal(await tool.execute({ subagent: "explorer", prompt: "x" }, CTX), "plain report");
});

/* ── transcript store ──────────────────────────────────────────────────── */

test("subagent transcripts round-trip and survive a torn write", () => {
  const dir = tempDir();
  try {
    const store = new SubagentStateStore(dir);
    assert.equal(store.load("missing"), undefined);

    store.save({
      agentId: "a1",
      subagent: "explorer",
      sessionId: "s1",
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ],
    });

    const loaded = store.load("a1");
    assert.equal(loaded?.subagent, "explorer");
    assert.equal(loaded?.messages.length, 2);
    assert.equal(loaded?.messages[1]?.content, "hello");

    // No temp files left behind: a save that landed is a single JSON document.
    assert.deepEqual(readdirSync(join(dir, "subagent-state")), ["a1.json"]);

    // A truncated file reads back as "cannot resume", not as a crash.
    writeFileSync(join(dir, "subagent-state", "a1.json"), "{ not json", "utf8");
    assert.equal(store.load("a1"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcript ids that would escape the state directory are refused", () => {
  const dir = tempDir();
  try {
    const store = new SubagentStateStore(dir);
    store.save({
      agentId: "../escape",
      subagent: "explorer",
      sessionId: "s1",
      createdAt: 1,
      updatedAt: 1,
      messages: [{ role: "user", content: "x" }],
    });
    // Nothing was written anywhere, and the id cannot be read back either.
    assert.equal(store.load("../escape"), undefined);
    assert.equal(existsOrEmpty(join(dir, "subagent-state")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function existsOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/* ── subagent hooks ────────────────────────────────────────────────────── */

test("subagentStart and subagentStop load from hooks.json and gate delegated work", async () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, ".deyin"), { recursive: true });
    const blocker = join(dir, "block.sh");
    writeFileSync(blocker, "#!/bin/sh\nexit 2\n", "utf8");
    chmodSync(blocker, 0o755);
    const note = join(dir, "note.sh");
    writeFileSync(note, `#!/bin/sh\necho '{"additional_context":"reviewed by policy"}'\n`, "utf8");
    chmodSync(note, 0o755);

    writeFileSync(
      join(dir, ".deyin", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          subagentStart: [{ command: blocker, matcher: "^shell$" }],
          subagentStop: [{ command: note }],
        },
      }),
      "utf8",
    );

    // A separate (empty) user dir: passing `dir` for both would load the same
    // hooks.json twice.
    const hooks = await loadHooks(dir, join(dir, "empty-home"));
    assert.equal(hooks.filter((h) => h.event === "subagentStart").length, 1);
    assert.equal(hooks.filter((h) => h.event === "subagentStop").length, 1);

    // The matcher is the subagent name, so only `shell` is blocked.
    const blocked = await runHooks(hooks, "subagentStart", "shell", { subagent: "shell" });
    assert.equal(blocked.blocked, true);
    const allowed = await runHooks(hooks, "subagentStart", "explorer", { subagent: "explorer" });
    assert.equal(allowed.blocked, false);

    // A stop hook cannot block, but what it prints reaches the report.
    const stop = await runHooks(hooks, "subagentStop", "explorer", { subagent: "explorer" });
    assert.equal(stop.blocked, false);
    assert.deepEqual(stop.additionalContext, ["reviewed by policy"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── resume / fork, end to end through runSubagent ─────────────────────── */

/** A subagent run against the mock provider, with a transcript store attached. */
async function runWith(
  opts: {
    url: string;
    cwd: string;
    store: SubagentStateStore;
    sessionId?: string;
    def?: SubagentDefinition;
    resumeAgentId?: string;
    forkAgentId?: string;
  },
  prompt: string,
) {
  return runSubagent(opts.def ?? WRITER, prompt, {
    cwd: opts.cwd,
    parent: { model: "test-model", providerId: "openference" },
    parentRouting: { apiBaseUrl: opts.url, getToken: async () => "test-token" },
    permissionEngine: new PermissionEngine(),
    resolvePermission: async () => "deny",
    state: opts.store,
    sessionId: opts.sessionId ?? "s1",
    resumeAgentId: opts.resumeAgentId,
    forkAgentId: opts.forkAgentId,
  });
}

test("resume continues the subagent's own transcript under the same agent id", async () => {
  const dir = tempDir();
  const server = await startMockOpenAI((i) => textResponse(`reply ${i}`));
  try {
    const store = new SubagentStateStore(dir);
    const first = await runWith({ url: server.url, cwd: dir, store }, "first question");
    assert.equal(first.ok, true);
    assert.ok(first.agentId, "a run with a store reports an agent id");

    const second = await runWith(
      { url: server.url, cwd: dir, store, resumeAgentId: first.agentId },
      "follow-up question",
    );
    assert.equal(second.ok, true);
    // Resume is the same agent carrying on, so the id is stable.
    assert.equal(second.agentId, first.agentId);

    // The second request carried the first exchange: that is the whole point.
    const sent = server.requests[1] as { messages: { role: string; content: string }[] };
    const userTurns = sent.messages.filter((m) => m.role === "user").map((m) => m.content);
    assert.deepEqual(userTurns, ["first question", "follow-up question"]);
    assert.ok(
      sent.messages.some((m) => m.role === "assistant" && m.content === "reply 0"),
      "the child's earlier answer is replayed to it",
    );
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fork branches into a new transcript and leaves the source untouched", async () => {
  const dir = tempDir();
  const server = await startMockOpenAI((i) => textResponse(`reply ${i}`));
  try {
    const store = new SubagentStateStore(dir);
    const base = await runWith({ url: server.url, cwd: dir, store }, "shared investigation");
    const baseMessagesBefore = store.load(base.agentId!)!.messages.length;

    const forked = await runWith(
      { url: server.url, cwd: dir, store, forkAgentId: base.agentId },
      "branch A",
    );
    assert.equal(forked.ok, true);
    assert.notEqual(forked.agentId, base.agentId, "a fork gets its own id");
    assert.equal(store.load(forked.agentId!)?.forkedFrom, base.agentId);

    // The source transcript did not grow: the branch wrote only to its own copy.
    assert.equal(store.load(base.agentId!)!.messages.length, baseMessagesBefore);
    const branch = store.load(forked.agentId!)!;
    assert.ok(branch.messages.some((m) => m.role === "user" && m.content === "shared investigation"));
    assert.ok(branch.messages.some((m) => m.role === "user" && m.content === "branch A"));
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume is refused across subagents, across sessions, and for unknown ids", async () => {
  const dir = tempDir();
  const server = await startMockOpenAI(() => textResponse("ok"));
  try {
    const store = new SubagentStateStore(dir);
    const base = await runWith({ url: server.url, cwd: dir, store, sessionId: "s1" }, "q");

    const unknown = await runWith({ url: server.url, cwd: dir, store, resumeAgentId: "nope" }, "q");
    assert.equal(unknown.ok, false);
    assert.match(unknown.report, /no subagent transcript found/);

    // A transcript written by one subagent is not context another may inherit.
    const wrongAgent = await runWith(
      { url: server.url, cwd: dir, store, def: DEF, resumeAgentId: base.agentId },
      "q",
    );
    assert.equal(wrongAgent.ok, false);
    assert.match(wrongAgent.report, /belongs to subagent "test-runner"/);

    const wrongSession = await runWith(
      { url: server.url, cwd: dir, store, sessionId: "s2", resumeAgentId: base.agentId },
      "q",
    );
    assert.equal(wrongSession.ok, false);
    assert.match(wrongSession.report, /different session/);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without a state store runs stay one-shot and resume says so", async () => {
  const dir = tempDir();
  const server = await startMockOpenAI(() => textResponse("ok"));
  try {
    const base = {
      cwd: dir,
      parent: { model: "test-model", providerId: "openference" },
      parentRouting: { apiBaseUrl: server.url, getToken: async () => "test-token" },
      permissionEngine: new PermissionEngine(),
      resolvePermission: async () => "deny" as const,
    };
    const plain = await runSubagent(WRITER, "q", base);
    assert.equal(plain.ok, true);
    assert.equal(plain.agentId, undefined, "no store means no resumable id to advertise");

    const resumed = await runSubagent(WRITER, "q", { ...base, resumeAgentId: "x" });
    assert.equal(resumed.ok, false);
    assert.match(resumed.report, /does not persist subagent transcripts/);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
