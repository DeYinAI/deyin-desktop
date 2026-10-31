import assert from "node:assert/strict";
import { test } from "node:test";
import { AssessmentSchema, assessmentOutcome, directionAllowed } from "../src/agents/assessment.js";
import { followUpNotice } from "../src/agents/cards.js";
import { ticketStage } from "../src/core/model.js";
import { agentsWorld, call } from "./agents-world.js";
import { AGENT, makeSettings, request, trigger } from "./helpers.js";

const DIRECTION = { implementation_requested: true, target_basis: "specified", requires_design_decision: false, evidence: "asked to fix it" } as const;

function assessment(world: ReturnType<typeof agentsWorld>, triggerId: string, patch: Record<string, unknown> = {}) {
  const rules = world.current.settings.policy.rules.filter((rule) => rule.enabled);
  return {
    trigger_id: triggerId, decision: "accept", rule_assessments: rules.map((rule, index) => ({ rule_id: rule.id, matched: index === 0, reason: "it is a typo" })),
    direction: DIRECTION, title: "Fix typo", worktree_name: "fix-typo", scope: "Fix the typo in the README", intent_evidence: "'there is a typo'", acknowledgement: "Fixing the README typo.",
    reason: "A clear typo fix", ...patch,
  };
}

/** Settings that observe comments, so an unaddressed message from an allowed sender is a candidate. */
const observing = (mode: "observe" | "auto" = "observe") => makeSettings({ github: { observeComments: true }, eval: { mode } });

/** A proactive candidate: a person's comment that does not address the agent. */
const proactive = (patch: Parameters<typeof trigger>[0] = {}) => trigger({ text: "there is a typo in the README", ...patch });

test("the assessment schema refuses a worktree name that is not short english kebab-case", () => {
  const world = agentsWorld();
  const base = assessment(world, "t1");
  assert.equal(AssessmentSchema.parse(base).worktree_name, "fix-typo");
  for (const bad of ["Fix-Typo", "fix_typo", "修复", "a-b-c-d-e", "fix-"]) assert.throws(() => AssessmentSchema.parse({ ...base, worktree_name: bad }), /worktree_name/);
  assert.throws(() => AssessmentSchema.parse({ ...base, extra: 1 }), /unknown property/);
  assert.throws(() => AssessmentSchema.parse({ ...base, acknowledgement: Array.from({ length: 120 }, () => "word").join(" ") }), /acknowledgement/);
});

test("an assessment must cover every enabled rule exactly once", () => {
  const world = agentsWorld();
  const parsed = AssessmentSchema.parse(assessment(world, "t1"));
  assert.throws(() => assessmentOutcome({ ...parsed, rule_assessments: parsed.rule_assessments.slice(1) }, world.current.settings, "inferred"), /every enabled rule/);
  assert.throws(() => assessmentOutcome({ ...parsed, rule_assessments: [...parsed.rule_assessments, parsed.rule_assessments[0]!] }, world.current.settings, "inferred"), /every enabled rule/);
  assert.throws(() => assessmentOutcome({ ...parsed, rule_assessments: parsed.rule_assessments.map((item) => ({ ...item, rule_id: "nope" })) }, world.current.settings, "inferred"), /every enabled rule/);
});

test("an unsettled direction or an unmatched rule turns an accept into an ignore", () => {
  const world = agentsWorld(makeSettings({ eval: { mode: "auto" } }));
  const parsed = AssessmentSchema.parse(assessment(world, "t1"));
  const undetermined = assessmentOutcome({ ...parsed, direction: { ...DIRECTION, target_basis: "undetermined" } }, world.current.settings, "inferred");
  assert.equal(undetermined.kind, "ignore");
  const design = assessmentOutcome({ ...parsed, direction: { ...DIRECTION, requires_design_decision: true } }, world.current.settings, "inferred");
  assert.equal(design.kind, "ignore");
  const none = assessmentOutcome({ ...parsed, rule_assessments: parsed.rule_assessments.map((item) => ({ ...item, matched: false })) }, world.current.settings, "inferred");
  assert.deepEqual(none.kind === "ignore" && none.reason, { code: "noRuleMatched" });
  assert.equal(directionAllowed(DIRECTION), true);
});

test("acceptance needs evidence and a name; observe mode records what would have been accepted", () => {
  const observe = agentsWorld();
  const parsed = AssessmentSchema.parse(assessment(observe, "t1"));
  assert.throws(() => assessmentOutcome({ ...parsed, intent_evidence: undefined }, observe.current.settings, "inferred"), /intent_evidence/);
  assert.throws(() => assessmentOutcome({ ...parsed, worktree_name: undefined }, observe.current.settings, "inferred"), /worktree_name/);
  const recorded = assessmentOutcome(parsed, observe.current.settings, "inferred");
  assert.equal(recorded.kind, "ignore");
  assert.equal(recorded.kind === "ignore" && recorded.audit?.would_accept, true);
  const auto = agentsWorld(makeSettings({ eval: { mode: "auto" } }));
  const accepted = assessmentOutcome(AssessmentSchema.parse(assessment(auto, "t1")), auto.current.settings, "inferred");
  assert.equal(accepted.kind, "accept");
  assert.equal(accepted.kind === "accept" && accepted.name, "fix-typo");
});

test("route accepts an explicit request as a ticket with its execution and queues the acknowledgement", async () => {
  const world = agentsWorld();
  const ticketId = await world.accept(request());
  const ticket = world.state.tickets.get(ticketId)!;
  assert.equal(ticket.execution?.name, `fix-typo-${ticketId}`);
  assert.equal(ticket.execution?.directory, `/work/fix-typo-${ticketId}`);
  assert.equal(world.engine.receiptsPending()[0]?.purpose, "acknowledgement");
  assert.ok(world.woken.count > 0);
});

test("route answers each item on its own: a refused item leaves the others", async () => {
  const world = agentsWorld();
  const first = request({ number: 1 });
  const second = request({ number: 2 });
  world.receive(first);
  world.receive(second);
  const answer = await call(world.orchestrator(), "orchestrator_route", {
    decisions: [
      { kind: "accept", trigger_id: first.id, title: "Fix typo" },
      { kind: "ignore", trigger_id: second.id },
      { kind: "accept", trigger_id: second.id, title: "Second", worktree_name: "second-task", acknowledgement: "Doing the second task." },
      { kind: "accept", trigger_id: "missing", title: "x", worktree_name: "xx", acknowledgement: "ok." },
    ],
  });
  assert.match(answer.results[0].refused, /accept needs worktree_name/);
  assert.match(answer.results[1].refused, /ignore needs reason/);
  assert.equal(answer.results[2].decision, "accept");
  assert.match(answer.results[3].refused, /No assessment|Unknown trigger/i);
  assert.equal(world.state.tickets.size, 1);
  // The first item was refused before it ran, so its trigger is still waiting.
  assert.ok(world.engine.candidate(first.id));
});

test("route refuses to accept an inferred candidate: that goes through eval_decide", async () => {
  const world = agentsWorld(observing());
  const t = proactive();
  world.receive(t);
  const answer = await call(world.orchestrator(), "orchestrator_route", { decisions: [{ kind: "accept", trigger_id: t.id, title: "Fix", worktree_name: "fix-it", acknowledgement: "Fixing it." }] });
  assert.match(answer.results[0].refused, /explicit|eval_decide/i);
  assert.equal(world.state.tickets.size, 0);
});

test("an inferred candidate is assessed with eval, eval_read and eval_decide", async () => {
  const world = agentsWorld(observing("auto"));
  world.fake.addIssue({ number: 7, title: "README typo", body: "There is a typo in the readme" });
  const comment = world.fake.addComment(7, { user: "alice", body: "there is a typo in the README" });
  const t = proactive({ number: 7, meta: { number: 7, isPr: false, kind: "conversation", commentId: comment.id } });
  world.receive(t);
  const tools = world.orchestrator();
  await assert.rejects(call(tools, "orchestrator_eval_decide", assessment(world, t.id)), /orchestrator_eval/);
  const context = await call(tools, "orchestrator_eval", { trigger_id: t.id });
  assert.equal(context.thread, "github:7");
  assert.ok(Array.isArray(context.window) && context.window.length >= 2);
  const root = await call(tools, "orchestrator_eval_read", { trigger_id: t.id, resource: "root" });
  assert.match(root.text, /typo in the readme/);
  const page = await call(tools, "orchestrator_eval_read", { trigger_id: t.id, resource: "thread" });
  assert.equal(page.messages.length, 2);
  await assert.rejects(call(tools, "orchestrator_eval_read", { trigger_id: t.id, resource: "file" }), /path is required/);
  await assert.rejects(call(tools, "orchestrator_eval_read", { trigger_id: t.id, resource: "image", image_id: "x" }), /cannot read images/);
  const decided = await call(tools, "orchestrator_eval_decide", assessment(world, t.id));
  assert.equal(decided.decision, "accept");
  assert.equal(world.state.tickets.size, 1);
  await assert.rejects(call(tools, "orchestrator_eval", { trigger_id: t.id }), /finished/);
});

test("in observe mode an accepted assessment is recorded as would-accept and creates no ticket", async () => {
  const world = agentsWorld(observing());
  const t = proactive();
  world.receive(t);
  const tools = world.orchestrator();
  await call(tools, "orchestrator_eval", { trigger_id: t.id });
  const answer = await call(tools, "orchestrator_eval_decide", assessment(world, t.id));
  assert.equal(answer.decision, "ignore");
  assert.equal(world.state.tickets.size, 0);
  const decision = [...world.state.decisions.values()][0]!;
  assert.equal(decision.audit?.would_accept, true);
});

test("an explicit candidate is not assessed", async () => {
  const world = agentsWorld();
  const t = request();
  world.receive(t);
  await assert.rejects(call(world.orchestrator(), "orchestrator_eval", { trigger_id: t.id }), /explicit/);
});

test("orchestrator_read lists and reads; a worker reads only its own ticket", async () => {
  const world = agentsWorld();
  const a = await world.accept(request({ number: 1 }), "fix-one");
  const b = await world.accept(request({ number: 2 }), "fix-two");
  const orchestrator = world.orchestrator();
  const list = await call(orchestrator, "orchestrator_read", { resource: "tickets" });
  assert.equal(list.total, 2);
  assert.equal(list.items[0].ticket_id, b, "newest first");
  const detail = await call(orchestrator, "orchestrator_read", { resource: `ticket/${a}` });
  assert.equal(detail.ticket_id, a);
  assert.match((await call(orchestrator, "orchestrator_read", { resource: `ticket/${a}/assignment` })).text, /Fix typo|typo/);
  assert.equal((await call(orchestrator, "orchestrator_read", { resource: "settings" })).mode, "observe");
  await assert.rejects(call(orchestrator, "orchestrator_read", { resource: "nonsense" }), /Unknown resource/);
  await assert.rejects(call(orchestrator, "orchestrator_read", { resource: "ticket/nope" }), /Unknown ticket/);
  const worker = world.worker(a);
  assert.equal((await call(worker, "orchestrator_read", { resource: `ticket/${a}` })).ticket_id, a);
  await assert.rejects(call(worker, "orchestrator_read", { resource: `ticket/${b}` }), /only its own ticket/);
  await assert.rejects(call(worker, "orchestrator_read", { resource: "tickets" }), /not readable by a worker/);
  await assert.rejects(call(worker, "orchestrator_read", { resource: "settings" }), /not readable by a worker/);
  const own = world.state.tickets.get(a)!.origin.triggerId;
  assert.match((await call(worker, "orchestrator_read", { resource: `trigger/${own}` })).text, /fix the typo/);
  const other = world.state.tickets.get(b)!.origin.triggerId;
  await assert.rejects(call(worker, "orchestrator_read", { resource: `trigger/${other}` }), /reached its ticket|reached/);
  await assert.rejects(call(worker, "orchestrator_read", { resource: "thread/github:2" }), /follows/);
  assert.equal((await call(worker, "orchestrator_read", { resource: "thread/github:1" })).thread, "github:1");
});

test("a text resource pages by characters", async () => {
  const world = agentsWorld();
  const id = await world.accept(request({ text: `@${AGENT} ${"word ".repeat(500)}` }));
  const own = world.state.tickets.get(id)!.origin.triggerId;
  const first = await call(world.worker(id), "orchestrator_read", { resource: `trigger/${own}`, limit: 100 });
  assert.equal(first.text.length, 100);
  assert.equal(first.next_offset, 100);
  const second = await call(world.worker(id), "orchestrator_read", { resource: `trigger/${own}`, offset: first.next_offset, limit: 100 });
  assert.notEqual(second.text, first.text);
});

test("github resources are served through the reader", async () => {
  const world = agentsWorld();
  world.fake.addIssue({ number: 3, title: "Bug", body: "It breaks" });
  const id = await world.accept(request());
  const body = await call(world.worker(id), "orchestrator_read", { resource: "github/issues/3" });
  assert.match(body.text, /It breaks/);
  await assert.rejects(call(world.worker(id), "orchestrator_read", { resource: "github/pulls/3" }), /pull request|issue/i);
});

test("unknown arguments and bad values are refused with the property named", async () => {
  const world = agentsWorld();
  await assert.rejects(call(world.orchestrator(), "orchestrator_read", { resource: "tickets", bogus: 1 }), /bogus/);
  await assert.rejects(call(world.orchestrator(), "orchestrator_read", { resource: "tickets", limit: 0 }), /limit/);
  await assert.rejects(call(world.orchestrator(), "orchestrator_route", { decisions: [] }), /decisions/);
});

test("a worker reports progress, ready and blocked; ready without a PR completes the ticket", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  world.start(id);
  const worker = world.worker(id);
  const progress = await call(worker, "orchestrator_report", { state: "progress", summary: "Looking at it" });
  assert.deepEqual(progress, { reported: true, notification: "internal_only" });
  const asked = await call(worker, "orchestrator_report", { state: "progress", summary: "Need input", human_action: "Which file?" });
  assert.equal(asked.notification, "orchestrator");
  assert.equal(asked.attention.question, "Which file?");
  assert.equal(ticketStage(world.state.tickets.get(id)!), "person");
  await call(worker, "orchestrator_report", { state: "blocked", summary: "Cannot continue", human_action: null });
  assert.equal(ticketStage(world.state.tickets.get(id)!), "blocked");
  await call(worker, "orchestrator_report", { state: "ready", summary: "Done" });
  assert.equal(world.state.tickets.get(id)?.ended?.outcome, "completed");
  await assert.rejects(call(worker, "orchestrator_report", { state: "progress", summary: "late" }), /ended/);
  assert.ok(world.engine.pendingNotices().some((notice) => /ready/.test(notice.text)));
});

test("a report that claims a pull request binds it, and ready then waits for the merge", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  world.start(id);
  const execution = world.state.tickets.get(id)!.execution!;
  world.fake.addIssue({ number: 9, user: AGENT, pr: { head: `agent/${execution.name}` } });
  await call(world.worker(id), "orchestrator_report", { state: "ready", summary: "PR opened", pr_number: 9 });
  const ticket = world.state.tickets.get(id)!;
  assert.equal(ticket.ended, undefined, "the ticket waits for its pull request");
  assert.deepEqual(ticket.follows?.map((follow) => [follow.thread, follow.own]), [["github:9", true]]);
  assert.ok(world.state.threads.get("github:9")?.subscriptions.includes(id));
  assert.equal(ticketStage(ticket), "review");
});

test("a refused pull request claim records nothing", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  world.start(id);
  world.fake.addIssue({ number: 9, user: "someone-else", pr: { head: "feature/other" } });
  await assert.rejects(call(world.worker(id), "orchestrator_report", { state: "ready", summary: "PR", pr_number: 9 }), /not opened by agent-bot/);
  world.fake.addIssue({ number: 10, user: AGENT, pr: { head: "agent/some-other-branch" } });
  await assert.rejects(call(world.worker(id), "orchestrator_report", { state: "ready", summary: "PR", pr_number: 10 }), /last path segment/);
  await assert.rejects(call(world.worker(id), "orchestrator_report", { state: "ready", summary: "PR", pr_number: 11 }), /does not exist/);
  const ticket = world.state.tickets.get(id)!;
  assert.equal(ticket.assignments.at(-1)?.report, undefined);
  assert.equal(ticket.follows?.length, 0);
  assert.equal(ticket.ended, undefined);
});

test("a report that names a message that never reached the ticket is refused whole, even with a claim", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  world.start(id);
  const execution = world.state.tickets.get(id)!.execution!;
  world.fake.addIssue({ number: 9, user: AGENT, pr: { head: `agent/${execution.name}` } });
  await assert.rejects(call(world.worker(id), "orchestrator_report", { state: "progress", summary: "x", pr_number: 9, reply_to_trigger_id: "nope" }), /reached this ticket/);
  const ticket = world.state.tickets.get(id)!;
  assert.equal(ticket.follows?.length, 0, "the pull request was not bound");
  assert.equal(ticket.assignments.at(-1)?.report, undefined);
});

test("a worker acknowledges the request that reached it, once", async () => {
  const world = agentsWorld();
  const t = request();
  const id = await world.accept(t);
  const worker = world.worker(id);
  // Accepting the request already queued its acknowledgement, so the worker's one reuses it.
  const first = await call(worker, "orchestrator_ack", { trigger_id: t.id, text: "Looking into the typo." });
  assert.equal(first.reused, true);
  const again = await call(worker, "orchestrator_ack", { trigger_id: t.id, text: "Looking into the typo." });
  assert.equal(again.reused, true);
  await assert.rejects(call(worker, "orchestrator_ack", { trigger_id: "nope", text: "hi" }), /Unknown trigger/);
  await assert.rejects(call(worker, "orchestrator_ack", { trigger_id: t.id, text: Array.from({ length: 150 }, () => "word").join(" ") }), /words/);
});

test("a worker follows and unfollows threads and hands a message back", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  const worker = world.worker(id);
  const followed = await call(worker, "orchestrator_thread_follow", { thread: "github:5", reason: "The issue behind it" });
  assert.equal(followed.followed, true);
  assert.ok(world.engine.pendingNotices().some((notice) => /follows github:5/.test(notice.text)));
  await assert.rejects(call(worker, "orchestrator_thread_follow", { thread: "nonsense", reason: "x" }), /<source>:<id>/);
  await call(worker, "orchestrator_thread_unrelated", { thread: "github:5", reason: "Not about this" });
  assert.ok(!world.state.threads.get("github:5")?.subscriptions.includes(id));
  const follow = trigger({ number: 1, text: "also please add dark mode" });
  world.engine.receive(follow);
  world.engine.evaluateDue();
  const handed = await call(worker, "orchestrator_trigger_handback", { trigger_id: follow.id, reason: "Asks for another feature" });
  assert.equal(handed.trigger_id, follow.id);
});

test("requeue refuses a follow-up whose ticket's worker decides it", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  world.start(id);
  const follow = trigger({ number: 1, text: "and the footer too", actor: { source: "github", id: "alice" } });
  world.engine.receive(follow);
  world.engine.evaluateDue();
  const ticket = world.state.tickets.get(id)!;
  assert.ok(ticket.inputs.some((input) => input.kind === "trigger" && input.triggerId === follow.id));
  await assert.rejects(call(world.orchestrator(), "orchestrator_trigger_requeue", { trigger_id: follow.id }), /worker decides/);
});

test("retry, status request and notes act on a ticket and wake the drivers", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  world.start(id);
  const tools = world.orchestrator();
  await assert.rejects(call(tools, "orchestrator_ticket_retry", { ticket_id: id }), /only a failed or blocked ticket/);
  const status = await call(tools, "orchestrator_ticket_request_status", { ticket_id: id });
  assert.match(status.reason, /not waiting/);
  await call(tools, "orchestrator_ticket_note", { ticket_id: id, text: "Ticket 2 found the same typo in the docs" });
  assert.ok(world.state.tickets.get(id)!.inputs.some((input) => input.kind === "note"));
  await call(world.worker(id), "orchestrator_report", { state: "failed", summary: "Tests fail" });
  const retried = await call(tools, "orchestrator_ticket_retry", { ticket_id: id });
  assert.equal(retried.ticket.state, "working/queued");
  assert.equal(world.state.tickets.get(id)!.assignments.length, 2);
});

test("reply sends an answer only for a person's question the ticket took up, and a result after ready", async () => {
  const world = agentsWorld();
  const t = request();
  const id = await world.accept(t);
  world.start(id);
  await assert.rejects(call(world.orchestrator(), "orchestrator_reply", { purpose: "result", ticket_id: id, text: "Done!" }), /ready report/);
  await call(world.worker(id), "orchestrator_report", { state: "progress", summary: "ok", reply_to_trigger_id: t.id });
  const answered = await call(world.orchestrator(), "orchestrator_reply", { purpose: "answer", trigger_id: t.id, ticket_id: id, text: "It is in README.md" });
  assert.equal(answered.status, "pending");
  const execution = world.state.tickets.get(id)!.execution!;
  world.fake.addIssue({ number: 9, user: AGENT, pr: { head: `agent/${execution.name}` } });
  await call(world.worker(id), "orchestrator_report", { state: "ready", summary: "PR ready", pr_number: 9 });
  const result = await call(world.orchestrator(), "orchestrator_reply", { purpose: "result", ticket_id: id, text: "The PR is ready: #9" });
  assert.equal(result.status, "pending");
});

test("unsubscribe drops every ticket subscription on a thread", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  const answer = await call(world.orchestrator(), "orchestrator_thread_unsubscribe", { thread: "github:1" });
  assert.equal(answer.removed, 1);
  assert.ok(!world.state.threads.get("github:1")?.subscriptions.includes(id));
});

test("a person's message that a worker decides is told to the orchestrator, which may stop the ticket on it and nothing more", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  world.start(id);
  const ticket = world.state.tickets.get(id)!;
  const note = trigger({ text: "actually, never mind: stop please" });
  world.receive(note);
  assert.equal(world.engine.candidates().length, 0, "the worker decides it; it is not a candidate");

  const [notice] = world.engine.pendingNotices().filter((item) => item.kind === "follow_up");
  assert.equal(notice?.triggerId, note.id);
  const told = JSON.parse(followUpNotice(world.state, note.id)!);
  assert.equal(told.kind, "follow_up");
  assert.equal(told.trigger_id, note.id);
  assert.equal(told.text, "actually, never mind: stop please");
  assert.deepEqual(told.delivered_to.map((item: { ticket_id: string }) => item.ticket_id), [id]);
  assert.match(told.note, /act only if the person asks to stop/);

  // Not the same as a message the person never sent to this ticket, and not an accept or ignore.
  const other = trigger({ number: 9, text: "unrelated" });
  world.receive(other);
  const refused = await call(world.orchestrator(), "orchestrator_route", { decisions: [{ kind: "stop", trigger_id: other.id, ticket_id: id }] });
  assert.match(refused.results[0].refused, /did not reach|No assessment/i);
  assert.equal(ticket.ended, undefined);
  await assert.rejects(call(world.orchestrator(), "orchestrator_trigger_requeue", { trigger_id: note.id }), /worker decides/);

  const stopped = await call(world.orchestrator(), "orchestrator_route", { decisions: [{ kind: "stop", trigger_id: note.id, ticket_id: id, reason: "The person asked to stop" }] });
  assert.equal(stopped.results[0].decision, "stop");
  const ended = world.state.tickets.get(id)!.ended;
  assert.equal(ended?.by, "human");
  assert.equal(ended?.outcome, "stopped");
  const again = await call(world.orchestrator(), "orchestrator_route", { decisions: [{ kind: "stop", trigger_id: note.id, ticket_id: id }] });
  assert.equal(again.results[0].decision, "stop", "stopping again answers the same");
  assert.equal(followUpNotice(world.state, note.id), undefined, "nothing owns it any more");
  const later = trigger({ text: "go on after all" });
  world.receive(later);
  assert.ok(world.state.tickets.get(id)?.ended, "a stopped ticket stays stopped");
});

test("a follow-up is not announced when a person's message was not for a ticket's worker", () => {
  const world = agentsWorld();
  world.receive(request());
  world.receive(trigger({ number: 5, text: "just talking" }));
  assert.deepEqual(world.engine.pendingNotices().filter((item) => item.kind === "follow_up"), []);
});
