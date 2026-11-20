import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_PERMISSIONS,
  rememberAlwaysAllow,
  updatePermissions,
  type BotApprovalMode,
  type BotPermissionSettings,
  type PersonAnswer,
  type ReviewClassifier,
  type ReviewRequest,
} from "@deyin/host-core";
import { createBotToolGuard, type ApprovalRequest, type GuardPermissions } from "../src/main/bots/tool-guard.js";
import { createReviewClassifier, createVerdictTool, type ReviewModel, type ReviewRunner } from "../src/main/bots/review-classifier.js";

const TIERS: Record<string, string> = { read_file: "read", write: "write", bash: "execute", mcp__gmail__send_email: "execute" };
const tierOf = (name: string): string | undefined => TIERS[name];

/** Settings held in memory, changed by the same pure functions the real store uses. */
function memoryPermissions(initial: BotPermissionSettings = EMPTY_PERMISSIONS): GuardPermissions & { saved: string[] } {
  let current = initial;
  const saved: string[] = [];
  return {
    saved,
    get: () => current,
    rememberAlways: (name) => {
      saved.push(name);
      current = rememberAlwaysAllow(current, name);
    },
  };
}

function guardWith(
  permissions: GuardPermissions,
  extra: { answer?: PersonAnswer; unattended?: boolean; classify?: ReviewClassifier; nameFor?: (n: string) => string; mode?: BotApprovalMode } = {},
) {
  const cards: ApprovalRequest[] = [];
  const guard = createBotToolGuard({
    mode: () => extra.mode ?? "auto_review",
    permissions,
    tierOf,
    classify: extra.classify,
    nameFor: extra.nameFor,
    ask: extra.unattended
      ? undefined
      : async (request) => {
          cards.push(request);
          return extra.answer ?? "deny";
        },
  });
  return { guard, cards };
}

test("a read goes ahead with no card", async () => {
  const h = guardWith(memoryPermissions());
  assert.equal(await h.guard({ name: "read_file" }, { path: "a.md" }, "Read a.md"), undefined);
  assert.equal(h.cards.length, 0);
});

test("a write shows a card with what it does and why it needs a yes", async () => {
  const h = guardWith(memoryPermissions(), { answer: "allow" });
  assert.equal(await h.guard({ name: "write" }, { path: "plan.md" }, "Write plan.md"), undefined);
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0]?.toolName, "write");
  assert.equal(h.cards[0]?.summary, "Write plan.md");
  assert.match(h.cards[0]?.reason ?? "", /needs your approval/);
});

test("declining blocks with a reason the Bot can read", async () => {
  const h = guardWith(memoryPermissions(), { answer: "deny" });
  const result = await h.guard({ name: "write" }, {}, "Write plan.md");
  assert.match(result?.block ?? "", /declined/);
});

test("always allow saves the exact tool and the next call is not asked again", async () => {
  const permissions = memoryPermissions();
  const h = guardWith(permissions, { answer: "allow-always" });
  assert.equal(await h.guard({ name: "mcp__gmail__send_email" }, {}, "Email Ana"), undefined);
  assert.equal(await h.guard({ name: "mcp__gmail__send_email" }, {}, "Email Bo"), undefined);
  assert.deepEqual(permissions.saved, ["mcp__gmail__send_email"]);
  assert.equal(h.cards.length, 1);
});

test("an unattended run is refused what needs a person and is never asked", async () => {
  const h = guardWith(memoryPermissions(), { unattended: true });
  const result = await h.guard({ name: "write" }, {}, "Write plan.md");
  assert.match(result?.block ?? "", /Nobody is here/);
  assert.equal(await h.guard({ name: "read_file" }, {}, "Read"), undefined);
});

test("a blocked or read-only refusal is never a question", async () => {
  const blocked = guardWith(memoryPermissions(updatePermissions(EMPTY_PERMISSIONS, { tool: { scope: "local", tool: "bash", permission: "blocked" } })), { answer: "allow" });
  assert.match((await blocked.guard({ name: "bash" }, {}, "Run ls"))?.block ?? "", /blocked/);
  const readOnly = guardWith(memoryPermissions(), { answer: "allow", mode: "read_only" });
  assert.match((await readOnly.guard({ name: "write" }, {}, "Write"))?.block ?? "", /read-only/);
  assert.equal(blocked.cards.length + readOnly.cards.length, 0);
});

test("a tool the run does not know is treated as able to change things", async () => {
  const h = guardWith(memoryPermissions(), { answer: "deny" });
  const result = await h.guard({ name: "mystery_tool" }, {}, "Do it");
  assert.ok(result?.block);
  assert.equal(h.cards.length, 1);
});

test("the reviewer sees the real arguments and the tool's tier", async () => {
  const seen: ReviewRequest[] = [];
  const settings = updatePermissions(EMPTY_PERMISSIONS, { autoReview: { allowInstructions: ["Email my team"] } });
  const h = guardWith(memoryPermissions(settings), {
    classify: async (request) => {
      seen.push(request);
      return { verdict: "allow", reason: "team" };
    },
  });
  assert.equal(await h.guard({ name: "mcp__gmail__send_email" }, { to: "ana@team.com" }, "Email Ana"), undefined);
  assert.deepEqual(seen[0]?.call.args, { to: "ana@team.com" });
  assert.equal(seen[0]?.call.tier, "execute");
  assert.equal(h.cards.length, 0, "auto review approved it, so no card");
});

test("a subagent's card names the subagent too", async () => {
  const h = guardWith(memoryPermissions(), { answer: "allow", nameFor: (n) => `researcher → ${n}` });
  await h.guard({ name: "write" }, {}, "Write notes");
  assert.equal(h.cards[0]?.toolName, "researcher → write");
});

test("anything unexpected is a refusal, never an objection the loop would ignore", async () => {
  const broken: GuardPermissions = {
    get: () => {
      throw new Error("settings unreadable");
    },
    rememberAlways: () => undefined,
  };
  const h = guardWith(broken, { answer: "allow" });
  const result = await h.guard({ name: "read_file" }, {}, "Read");
  assert.match(result?.block ?? "", /could not be checked/);
});

test("a settings change mid-run applies to the next call", async () => {
  const permissions = memoryPermissions();
  const h = guardWith(permissions, { answer: "deny" });
  assert.ok(await h.guard({ name: "write" }, {}, "Write"));
  permissions.rememberAlways("write");
  assert.equal(await h.guard({ name: "write" }, {}, "Write"), undefined);
});

/* The reviewer's model call ------------------------------------------------ */

const MODEL: ReviewModel = { apiBaseUrl: "http://localhost:1", getToken: async () => "t", model: "m", cwd: "/tmp" };
const REQUEST: ReviewRequest = {
  call: { name: "mcp__gmail__send_email", tier: "execute", summary: "Email Ana", args: { body: "hi" } },
  allowInstructions: ["Email my team"],
  blockInstructions: ["Never email outsiders"],
};
type RunOptions = Parameters<ReviewRunner>[0];

async function callTool(options: RunOptions, args: Record<string, unknown>): Promise<string> {
  const tool = options.tools.get("review_verdict");
  assert.ok(tool, "the verdict tool is registered");
  return tool.execute(args, {} as never);
}

test("the reviewer returns the verdict the model records", async () => {
  const classify = createReviewClassifier(MODEL, async (options) => {
    await callTool(options, { verdict: "block", reason: "Outsider." });
  });
  assert.deepEqual(await classify(REQUEST), { verdict: "block", reason: "Outsider." });
});

test("the reviewer's model has exactly one tool, no way to do anything, and the guarded prompt", async () => {
  let seen: RunOptions | undefined;
  const classify = createReviewClassifier(MODEL, async (options) => {
    seen = options;
    await callTool(options, { verdict: "ask", reason: "" });
  });
  await classify(REQUEST);
  assert.ok(seen);
  assert.deepEqual(seen.tools.names(), ["review_verdict"]);
  // Even a tool that needs approval is refused, since nobody can approve it.
  assert.equal(await seen.resolvePermission({ toolName: "bash", tier: "execute", args: {}, summary: "" }), "deny");
  assert.equal(seen.permissions.actionFor({ name: "bash", tier: "execute" }), "ask");
  assert.equal(seen.thinking, false);
  assert.equal(seen.model, "m");
  const [system, user] = seen.messages;
  assert.match(String(system?.content), /Block instructions win/);
  assert.match(String(user?.content), /Email my team/);
  assert.match(String(user?.content), /Never email outsiders/);
  assert.ok(seen.signal, "a timeout can stop it");
});

test("the first verdict stands; a later one cannot overturn it", async () => {
  const classify = createReviewClassifier(MODEL, async (options) => {
    await callTool(options, { verdict: "block", reason: "first" });
    await callTool(options, { verdict: "allow", reason: "second" });
  });
  assert.equal((await classify(REQUEST)).verdict, "block");
});

test("no verdict, a malformed one, or a model error all reject", async () => {
  await assert.rejects(createReviewClassifier(MODEL, async () => undefined)(REQUEST), /no verdict/);
  await assert.rejects(
    createReviewClassifier(MODEL, async (options) => {
      await callTool(options, { verdict: "sure", reason: "" });
    })(REQUEST),
  );
  await assert.rejects(createReviewClassifier(MODEL, async () => Promise.reject(new Error("model down")))(REQUEST), /model down/);
});

test("a reviewer that hangs is stopped at the timeout", async () => {
  const classify = createReviewClassifier(
    MODEL,
    (options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    20,
  );
  await assert.rejects(classify(REQUEST), /aborted/);
});

test("the verdict tool refuses a malformed verdict and does not record it", async () => {
  const recorded: unknown[] = [];
  const tool = createVerdictTool((v) => recorded.push(v));
  await assert.rejects(tool.execute({ verdict: "maybe" }, {} as never));
  assert.deepEqual(recorded, []);
  await tool.execute({ verdict: "allow", reason: "ok" }, {} as never);
  assert.equal(recorded.length, 1);
  assert.equal(tool.tier, "read");
});

test("a Bot's own note goes ahead with no card in a chat, and is refused in a run nobody watches", async () => {
  const tiers = { ...TIERS, remember: "execute" };
  const chat = createBotToolGuard({
    mode: () => "auto_review",
    permissions: memoryPermissions(),
    tierOf: (name) => tiers[name],
    ask: async () => "deny",
  });
  assert.equal(await chat({ name: "remember" }, { title: "Rule" }, "remember: Rule"), undefined);

  const unwatched = createBotToolGuard({ mode: () => "auto_review", permissions: memoryPermissions(), tierOf: (name) => tiers[name] });
  const refused = await unwatched({ name: "remember" }, { title: "Rule" }, "remember: Rule");
  assert.match(refused?.block ?? "", /Nobody is here to approve it/);
});
