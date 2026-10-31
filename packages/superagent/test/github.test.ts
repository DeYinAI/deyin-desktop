import assert from "node:assert/strict";
import { test } from "node:test";
import { ticketStage } from "../src/core/model.js";
import { GithubClient, GithubError, authenticatedAccount, canPush } from "../src/github/client.js";
import { claimPull, sendReceipt } from "../src/github/channel.js";
import { GithubReader } from "../src/github/read.js";
import { GithubSource, githubScope } from "../src/github/source.js";
import { MARKER, commentTrigger, githubAddress, mentions } from "../src/github/triggers.js";
import { settingsPolicy } from "../src/policy.js";
import { Engine } from "../src/core/engine.js";
import { State } from "../src/core/state.js";
import { FakeGithub } from "./fake-github.js";
import { AGENT, makeSettings } from "./helpers.js";
import type { Settings } from "../src/settings.js";

function world(settings: Settings = makeSettings()) {
  const fake = new FakeGithub();
  const current = { settings };
  const state = new State();
  const engine = new Engine(state, {
    policy: () => settingsPolicy(current.settings, githubScope(current.settings)),
    now: () => fake.clock.now,
    execution: ({ title, name }) => ({ name: name ?? title.toLowerCase().replace(/\W+/g, "-"), directory: `/w/${name ?? "x"}`, assignment: title }),
  });
  const client = new GithubClient({ fetch: fake.fetch, token: () => "token", now: () => fake.clock.now.getTime() });
  const source = new GithubSource({ client, engine, state, settings: () => current.settings, agentLogin: () => AGENT, now: () => fake.clock.now });
  return { fake, state, engine, client, source, current };
}

const accept = (w: ReturnType<typeof world>, triggerId: string, name = "fix-readme") => {
  w.engine.evaluateDue();
  return w.engine.decide(triggerId, { kind: "accept", title: "Fix README", scope: "typo", reason: "ok", name, acknowledgement: "On it." });
};

test("mentions matches the login only as a whole word and not inside emails", () => {
  assert.equal(mentions("hey @agent-bot please", "agent-bot"), true);
  assert.equal(mentions("@Agent-Bot", "agent-bot"), true);
  assert.equal(mentions("mail me@agent-bot.com", "agent-bot"), false);
  assert.equal(mentions("@agent-bots", "agent-bot"), false);
  assert.equal(mentions("x@agent-bot", "agent-bot"), false);
});

test("githubAddress parses issue, pull and discussion links of the watched repo only", () => {
  assert.deepEqual(githubAddress("https://github.com/acme/app/pull/12#discussion_r99", "acme/app"), { number: 12, pr: true, discussion: 99 });
  assert.deepEqual(githubAddress("https://github.com/acme/app/issues/3#issuecomment-1", "ACME/app"), { number: 3, pr: false });
  assert.equal(githubAddress("https://github.com/other/app/pull/12", "acme/app"), undefined);
});

test("the first poll sets cursors and ingests no history", async () => {
  const w = world();
  w.fake.addIssue({ number: 1, body: `@${AGENT} old request` });
  w.fake.notify(1);
  w.fake.tick();
  w.fake.clock.now = new Date(w.fake.clock.now.getTime() + 60_000);
  const report = await w.source.poll();
  assert.equal(report.triggers, 0);
  assert.equal(w.state.triggers.size, 0);
  assert.ok(w.state.cursors["gh:notifications"]);
});

test("a mention in a new issue after the first poll becomes an explicit candidate", async () => {
  const w = world();
  await w.source.poll();
  w.fake.tick();
  w.fake.addIssue({ number: 7, title: "Typo", body: `@${AGENT} fix the typo in README` });
  w.fake.notify(7);
  w.fake.tick();
  const report = await w.source.poll();
  assert.equal(report.failures.length, 0);
  assert.equal(report.triggers, 1);
  w.engine.evaluateDue();
  const [candidate] = w.engine.candidates();
  assert.equal(candidate?.strength, "explicit");
  assert.equal(candidate?.triggers[0]?.addressed, "mention");
  assert.equal(candidate?.thread.key, "github:7");
});

test("a mention comment on an existing issue is received once even across overlapping polls", async () => {
  const w = world();
  w.fake.addIssue({ number: 3, body: "plain issue" });
  await w.source.poll();
  w.fake.tick();
  w.fake.addComment(3, { user: "alice", body: `@${AGENT} please fix` });
  w.fake.notify(3);
  w.fake.tick();
  assert.equal((await w.source.poll()).triggers, 1);
  w.fake.notify(3);
  w.fake.tick();
  assert.equal((await w.source.poll()).triggers, 0, "same comment version is not a new trigger");
  assert.equal(w.state.triggers.size, 1);
});

test("the agent's own comments and marked replies are never ingested", async () => {
  const w = world();
  w.fake.addIssue({ number: 3 });
  await w.source.poll();
  w.fake.tick();
  w.fake.addComment(3, { user: AGENT, body: "on my way" });
  w.fake.addComment(3, { user: "alice", body: `${MARKER}r:abc -->` });
  w.fake.notify(3);
  w.fake.tick();
  assert.equal((await w.source.poll()).triggers, 0);
});

test("an assigned issue addresses the agent like a mention", async () => {
  const w = world();
  await w.source.poll();
  w.fake.tick();
  w.fake.addIssue({ number: 9, title: "Do this", body: "no mention", assignees: [AGENT] });
  w.fake.notify(9, "assign");
  w.fake.tick();
  await w.source.poll();
  w.engine.evaluateDue();
  assert.equal(w.engine.candidates()[0]?.strength, "explicit");
});

test("replies on a followed thread reach the ticket without a mention, and PR merge ends it", async () => {
  const w = world();
  await w.source.poll();
  w.fake.tick();
  w.fake.addIssue({ number: 7, body: `@${AGENT} fix README typo` });
  w.fake.notify(7);
  w.fake.tick();
  await w.source.poll();
  const [trigger] = [...w.state.triggers.values()];
  const decision = accept(w, trigger!.id);
  const ticket = w.state.tickets.get(decision.ticketId!)!;
  w.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id);
  w.engine.inputsDelivered(ticket.id, ticket.undelivered);
  // The worker opens PR 8 and claims it.
  w.fake.tick();
  w.fake.addIssue({ number: 8, user: AGENT, pr: { head: "agent/fix-readme" } });
  const claim = await claimPull(w.client, { repository: w.fake.repo, agent: AGENT }, ticket, 8);
  assert.equal(claim.refusal, undefined);
  w.engine.bindThread(ticket.id, { source: "github", id: "8" }, true);
  // Plain reply on the issue and a review comment on the PR, neither mentions the agent and no notification exists.
  w.fake.tick();
  w.fake.addComment(7, { user: "alice", body: "also the second heading please" });
  w.fake.addReviewComment(8, { user: "bob", body: "rename this" });
  w.fake.tick();
  const report = await w.source.poll();
  assert.equal(report.failures.length, 0, report.failures.join());
  assert.equal(ticket.inputs.filter((item) => item.kind === "trigger").length, 3);
  assert.equal(w.engine.candidates().length, 0, "the ticket's worker owns these follow-ups");
  w.engine.report(ticket.id, { state: "ready", summary: "PR opened" });
  assert.equal(ticketStage(ticket), "review");
  w.fake.tick();
  w.fake.close(8, true);
  await w.source.poll();
  assert.equal(ticket.ended?.outcome, "merged");
});

test("observed comments become inferred candidates only when the switch is on", async () => {
  const w = world(makeSettings({ github: { observeComments: true } }));
  w.fake.addIssue({ number: 4 });
  await w.source.poll();
  w.fake.tick();
  w.fake.addComment(4, { user: "alice", body: "this wording seems off" });
  w.fake.tick();
  await w.source.poll();
  w.engine.evaluateDue();
  assert.equal(w.engine.candidates()[0]?.strength, "inferred");

  const quiet = world();
  quiet.fake.addIssue({ number: 4 });
  await quiet.source.poll();
  quiet.fake.tick();
  quiet.fake.addComment(4, { user: "alice", body: "this wording seems off" });
  quiet.fake.tick();
  await quiet.source.poll();
  assert.equal(quiet.state.triggers.size, 0);
});

test("a rate limit lengthens the next interval and is reported without throwing", async () => {
  const w = world();
  w.fake.failures.push((_method, path) => (path === "notifications" ? { status: 403, body: { message: "rate limit" }, headers: { "retry-after": "120" } } : undefined));
  const report = await w.source.poll();
  assert.ok(report.intervalSeconds >= 120);
  assert.match(report.failures.join(), /notifications/);
});

test("an unchanged notification feed is a cheap 304 round", async () => {
  const w = world();
  await w.source.poll();
  const first = w.fake.requests.length;
  w.fake.tick();
  await w.source.poll();
  const second = w.fake.requests.length - first;
  assert.ok(second <= first, "no extra requests for an unchanged feed");
  assert.equal(w.state.cursors["gh:notifications:etag"] !== undefined, true);
});

test("no token or repository means the source does nothing", async () => {
  const w = world(makeSettings({ github: { repository: "" } }));
  const report = await w.source.poll();
  assert.deepEqual(report.failures, []);
  assert.equal(w.fake.requests.length, 0);
});

test("sendReceipt posts a marked comment once, even when retried", async () => {
  const w = world();
  w.fake.addIssue({ number: 5 });
  const receipt = { id: "r:x", purpose: "result" as const, text: "Fixed in #8", channel: { source: "github", thread: "github:5", address: { number: "5" } }, status: "pending" as const, attempts: 0, createdAt: w.fake.clock.now.toISOString() };
  const input = { repository: w.fake.repo, agent: AGENT };
  assert.equal(await sendReceipt(w.client, input, receipt), "sent");
  assert.equal(await sendReceipt(w.client, input, receipt), "sent");
  const posted = w.fake.posted(5);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.body, /Fixed in #8/);
  assert.match(posted[0]!.body, /deyin-superagent:r:x/);
});

test("sendReceipt replies inside a review thread, and reports a gone conversation", async () => {
  const w = world();
  w.fake.addIssue({ number: 6, user: "alice", pr: {} });
  const root = w.fake.addReviewComment(6, { user: "bob", body: "nit" });
  const receipt = { id: "r:y", purpose: "answer" as const, text: "Done", channel: { source: "github", thread: "github:6", address: { number: "6", url: root.html_url } }, status: "pending" as const, attempts: 0, createdAt: w.fake.clock.now.toISOString() };
  assert.equal(await sendReceipt(w.client, { repository: w.fake.repo, agent: AGENT }, receipt), "sent");
  const replies = w.fake.issues.get(6)!.reviewComments.filter((comment) => comment.in_reply_to_id === root.id);
  assert.equal(replies.length, 1);
  w.fake.failures.push((method) => (method === "POST" ? { status: 410, body: { message: "Gone" } } : undefined));
  const other = { ...receipt, id: "r:z", channel: { source: "github", thread: "github:6", address: { number: "6" } } };
  assert.equal(await sendReceipt(w.client, { repository: w.fake.repo, agent: AGENT }, other), "gone");
});

test("claimPull refuses issues, strangers' PRs and branches not named after the ticket", async () => {
  const w = world();
  await w.source.poll();
  w.fake.tick();
  w.fake.addIssue({ number: 1, body: `@${AGENT} do it` });
  w.fake.notify(1);
  w.fake.tick();
  await w.source.poll();
  const decision = accept(w, [...w.state.triggers.keys()][0]!);
  const ticket = w.state.tickets.get(decision.ticketId!)!;
  const input = { repository: w.fake.repo, agent: AGENT };
  w.fake.addIssue({ number: 2, user: AGENT, pr: { head: "agent/other-name" } });
  w.fake.addIssue({ number: 3, user: "mallory", pr: { head: "agent/fix-readme" } });
  w.fake.addIssue({ number: 4, user: AGENT, pr: { head: "agent/fix-readme" } });
  assert.match((await claimPull(w.client, input, ticket, 1)).refusal ?? "", /not a pull request/);
  assert.match((await claimPull(w.client, input, ticket, 2)).refusal ?? "", /last path segment/);
  assert.match((await claimPull(w.client, input, ticket, 3)).refusal ?? "", /not opened by/);
  assert.match((await claimPull(w.client, input, ticket, 99)).refusal ?? "", /does not exist/);
  assert.equal((await claimPull(w.client, input, ticket, 4)).refusal, undefined);
});

test("client: pagination follows Link headers, errors carry status, missing token is refused", async () => {
  const pages: string[] = [];
  const client = new GithubClient({
    token: () => "t",
    fetch: async (url) => {
      pages.push(url);
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      const headers = new Map<string, string>(page < 3 ? [["link", `<https://api.github.com/x?page=${page + 1}>; rel="next"`]] : []);
      return { status: 200, headers: { get: (name) => headers.get(name.toLowerCase()) ?? null }, text: async () => JSON.stringify([page]) };
    },
  });
  const result = await client.paginate<number>("x");
  assert.deepEqual(result.items, [1, 2, 3].slice(0, 3));
  assert.equal(result.truncated, false);
  const capped = await client.paginate<number>("x", {}, { maxPages: 2 });
  assert.equal(capped.truncated, true);
  await assert.rejects(new GithubClient({ token: () => undefined, fetch: async () => { throw new Error("no call"); } }).get("user"), (e: unknown) => e instanceof GithubError && e.status === 401);
});

test("client helpers: login and push permission", async () => {
  const w = world();
  assert.deepEqual(await authenticatedAccount(w.client), { login: AGENT, id: 4242, email: `4242+${AGENT}@users.noreply.github.com` });
  assert.equal(await canPush(w.client, w.fake.repo), true);
});

test("reader serves issue text pages, comment pages with bot flags, review threads and checks", async () => {
  const w = world();
  w.fake.addIssue({ number: 2, title: "Bug", body: "x".repeat(5000) });
  for (let i = 0; i < 25; i++) w.fake.addComment(2, { user: i === 0 ? "ci[bot]" : "alice", body: `c${i}`, type: i === 0 ? "Bot" : "User" });
  w.fake.addIssue({ number: 3, user: AGENT, pr: {} });
  const root = w.fake.addReviewComment(3, { user: "bob", body: "root" });
  w.fake.addReviewComment(3, { user: "alice", body: "reply", replyTo: root.id });
  const reader = new GithubReader({ client: w.client, repository: () => w.fake.repo });
  const description = (await reader.resource("issues/2", 0, undefined)) as { next_offset: number | null; total_chars: number };
  assert.equal(description.total_chars, 5000);
  assert.equal(description.next_offset, 4000);
  const first = (await reader.resource("issues/2/comments/1", 0, undefined)) as { entries: { bot?: true }[]; next_resource?: string };
  assert.equal(first.entries.length, 20);
  assert.equal(first.entries[0]?.bot, true);
  assert.equal(first.next_resource, "github/issues/2/comments/2");
  const second = (await reader.resource("issues/2/comments/2", 0, undefined)) as { entries: unknown[]; next_resource?: string };
  assert.equal(second.entries.length, 5);
  assert.equal(second.next_resource, undefined);
  const thread = (await reader.resource(`pulls/3/thread/${root.id + 1}`, 0, undefined)) as { entries: { text: string }[] };
  assert.deepEqual(thread.entries.map((entry) => entry.text), ["root", "reply"]);
  const checks = (await reader.resource("pulls/3/checks", 0, undefined)) as { checks: { name: string }[] };
  assert.equal(checks.checks[0]?.name, "ci");
  await assert.rejects(reader.resource("issues/3", 0, undefined), /pull request/);
  await assert.rejects(reader.resource("issues/99", 0, undefined), /not found/);
  await assert.rejects(reader.resource("nope/1", 0, undefined), /Unknown github resource/);
});

test("reader builds an assessment window with stubs and reads repository files", async () => {
  const w = world();
  w.fake.addIssue({ number: 2, title: "T", body: "opening" });
  for (let i = 0; i < 20; i++) {
    w.fake.tick();
    w.fake.addComment(2, { user: "alice", body: `message ${i} ${"y".repeat(600)}` });
  }
  w.fake.files.set("README.md", "# Title\nhello");
  const reader = new GithubReader({ client: w.client, repository: () => w.fake.repo });
  const { messages } = await reader.loadThread(2);
  assert.equal(messages.length, 21);
  const triggerId = messages[12]!.id;
  const window = GithubReader.window(messages, triggerId) as { id: string; stub?: string; trigger?: true; text?: string; chars?: number }[];
  assert.equal(window.length, 21);
  assert.ok(window[0]!.text, "the first messages are shown");
  assert.ok(window[19]!.stub, "far messages are stubs");
  assert.ok(window[8]!.text, "messages around the trigger are shown");
  assert.equal(window[12]!.trigger, true);
  assert.equal(window[12]!.chars !== undefined || window[12]!.text!.length > 0, true);
  const file = (await reader.repositoryPath("README.md", false, 0)) as { text: string };
  assert.match(file.text, /hello/);
  await assert.rejects(reader.repositoryPath("../etc/passwd", false, 0), /repository-relative/);
  await assert.rejects(reader.repositoryPath("missing.md", false, 0), /not found/);
});

test("commentTrigger carries addressed, channel and a version-sensitive id", () => {
  const base = { id: 1, body: `@${AGENT} hi`, user: { login: "alice" }, html_url: "https://github.com/acme/app/issues/1#issuecomment-1", updated_at: "2026-01-01T00:00:00Z" };
  const a = commentTrigger(base, { number: 1, isPr: false }, "conversation", AGENT);
  const b = commentTrigger({ ...base, updated_at: "2026-01-02T00:00:00Z" }, { number: 1, isPr: false }, "conversation", AGENT);
  assert.equal(a.addressed, "mention");
  assert.equal(a.human, true);
  assert.notEqual(a.id, b.id, "an edited comment is a new trigger");
  assert.equal(a.channel?.address.url, base.html_url);
  assert.equal(commentTrigger({ ...base, user: { login: AGENT } }, { number: 1, isPr: false }, "conversation", AGENT).human, false);
  assert.equal(commentTrigger({ ...base, user: { login: "x[bot]", type: "Bot" } }, { number: 1, isPr: false }, "conversation", AGENT).human, false);
});
