import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutorDriver } from "../src/agents/executor.js";
import { OrchestratorDriver } from "../src/agents/orchestrator.js";
import { composePrompt } from "../src/agents/prompts.js";
import { ticketStage } from "../src/core/model.js";
import { AgentRunError } from "../src/ports.js";
import { FakeWorkspace, ScriptedRunner, agentsWorld, call, silent, type AgentsWorld } from "./agents-world.js";
import { AGENT, makeSettings, request, trigger } from "./helpers.js";

const EMAIL = "1+agent-bot@users.noreply.github.com";

function orchestratorOf(world: AgentsWorld, runner: ScriptedRunner, clock = { now: 0 }) {
  const driver = new OrchestratorDriver({
    engine: world.engine, state: world.state, runner, tools: () => world.orchestrator(), prompt: () => composePrompt("orchestrator", { settings: world.current.settings, agent: { login: AGENT, email: EMAIL } }),
    settings: () => world.current.settings, allowed: world.allowed, logger: silent, now: () => clock.now,
  });
  return { driver, clock };
}

function executorOf(world: AgentsWorld, runner: ScriptedRunner, workspace = new FakeWorkspace(), token: string | null = "ghp_token") {
  const driver = new ExecutorDriver({
    engine: world.engine, state: world.state, runner, workspace, tools: (id) => world.worker(id), settings: () => world.current.settings, token: () => token ?? undefined,
    agent: () => ({ login: AGENT, email: EMAIL }), allowed: world.allowed, logger: silent,
  });
  return { driver, workspace };
}

const waitFor = async (check: () => boolean, message: string) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), message);
};

test("the orchestrator is given a waiting candidate once, and its decision is recorded", async () => {
  const world = agentsWorld();
  const t = request();
  world.receive(t);
  const runner = new ScriptedRunner(async (run) => {
    const card = JSON.parse(run.messages[0]!);
    assert.equal(card.trigger_id, t.id);
    assert.equal(card.strength, "explicit");
    assert.equal(run.role, "orchestrator");
    assert.deepEqual(run.env, {});
    assert.equal(run.cwd, undefined);
    await call(run.tools, "orchestrator_route", { decisions: [{ kind: "accept", trigger_id: t.id, title: "Fix typo", worktree_name: "fix-typo", acknowledgement: "Fixing the typo." }] });
  });
  const { driver } = orchestratorOf(world, runner);
  assert.equal(driver.hasWork(), true);
  driver.tick();
  assert.equal(driver.running, true);
  await driver.settle();
  assert.equal(world.state.tickets.size, 1);
  assert.equal(driver.hasWork(), false);
  driver.tick();
  await driver.settle();
  assert.equal(runner.runs.length, 1, "nothing more to give");
  assert.ok(world.engine.candidate(t.id) === undefined);
});

test("a candidate that arrives during a run reaches it through drain", async () => {
  const world = agentsWorld();
  const first = request({ number: 1 });
  const second = request({ number: 2 });
  world.receive(first);
  const drained: string[][] = [];
  const runner = new ScriptedRunner(async (run) => {
    world.receive(second);
    drained.push(run.drain());
    drained.push(run.drain());
  });
  const { driver } = orchestratorOf(world, runner);
  driver.tick();
  await driver.settle();
  assert.equal(drained[0]?.length, 1);
  assert.equal(JSON.parse(drained[0]![0]!).trigger_id, second.id);
  assert.deepEqual(drained[1], []);
});

test("notices are delivered after a successful run and kept after a failed one", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  world.engine.noticesDelivered(world.engine.pendingNotices().map((notice) => notice.id));
  world.start(id);
  await call(world.worker(id), "orchestrator_report", { state: "failed", summary: "Tests fail" });
  assert.equal(world.engine.pendingNotices().length, 1);
  const failing = new ScriptedRunner(() => {
    throw new Error("model unavailable");
  });
  const clock = { now: 1_000_000 };
  const { driver } = orchestratorOf(world, failing, clock);
  driver.tick();
  await driver.settle();
  assert.equal(world.engine.pendingNotices().length, 1, "kept for the next attempt");
  driver.tick();
  await driver.settle();
  assert.equal(failing.runs.length, 1, "backing off");
  clock.now += 5_000;
  failing.handler = (run) => {
    assert.match(run.messages.join("\n"), /failed/);
  };
  driver.tick();
  await driver.settle();
  assert.equal(failing.runs.length, 2);
  assert.equal(world.engine.pendingNotices().length, 0);
});

test("a follow-up notice is sent as the message the workers read, and dropped when no ticket owns it any more", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  world.engine.noticesDelivered(world.engine.pendingNotices().map((notice) => notice.id));
  world.start(id);
  const told = trigger({ text: "please stop" });
  world.receive(told);
  const runner = new ScriptedRunner();
  const { driver } = orchestratorOf(world, runner);
  driver.tick();
  await driver.settle();
  const message = JSON.parse(runner.runs[0]!.messages[0]!);
  assert.equal(message.kind, "follow_up");
  assert.equal(message.trigger_id, told.id);
  assert.equal(world.engine.pendingNotices().length, 0);

  // A second one whose ticket ends before the orchestrator gets to it has nothing left to say, and does not keep it busy.
  const late = trigger({ text: "and another thing" });
  world.receive(late);
  world.engine.stopTicket(id);
  assert.equal(world.engine.pendingNotices().length, 1);
  driver.tick();
  await driver.settle();
  assert.equal(runner.runs.length, 1, "no run for a notice that says nothing");
  assert.equal(world.engine.pendingNotices().length, 0);
  assert.equal(driver.hasWork(), false);
});

test("a failed run delivers its candidates again, and a restart does too", async () => {
  const world = agentsWorld();
  const t = request();
  world.receive(t);
  const runner = new ScriptedRunner(() => {
    throw new AgentRunError("no model", false);
  });
  const clock = { now: 0 };
  const { driver } = orchestratorOf(world, runner, clock);
  driver.tick();
  await driver.settle();
  assert.equal(world.engine.candidate(t.id)?.delivered, undefined, "undelivered after the failure");
  runner.handler = () => undefined;
  clock.now = 10 * 60_000;
  driver.tick();
  await driver.settle();
  assert.equal(runner.runs.length, 2);
  assert.ok(world.engine.candidate(t.id)?.delivered, "delivered again");
  const { driver: restarted } = orchestratorOf(world, runner);
  restarted.recover();
  assert.equal(world.engine.candidate(t.id)?.delivered, undefined);
  assert.equal(restarted.hasWork(), true);
});

test("nothing runs while superagent is disabled or paused", async () => {
  const world = agentsWorld(makeSettings({ enabled: false }));
  world.receive(request());
  const runner = new ScriptedRunner();
  const { driver } = orchestratorOf(world, runner);
  driver.tick();
  world.current.settings = makeSettings({ paused: true });
  driver.tick();
  await driver.settle();
  assert.equal(runner.runs.length, 0);
});

test("an evaluation the orchestrator never took expires instead of blocking its thread", async () => {
  const world = agentsWorld();
  const t = request();
  world.receive(t);
  assert.ok(world.engine.candidate(t.id));
  world.fake.tick(world.current.settings.eval.timeoutSeconds * 1000 * 7);
  world.engine.evaluateDue();
  assert.equal(world.engine.candidate(t.id), undefined);
  assert.equal([...world.state.decisions.values()][0]?.kind, "unavailable");
});

test("a worker starts in its own worktree with the credentials in its shell and the assignment first", async () => {
  const world = agentsWorld();
  const t = request();
  const id = await world.accept(t);
  const runner = new ScriptedRunner(async (run) => {
    assert.equal(run.role, "worker");
    assert.equal(run.sessionId, id);
    assert.equal(run.cwd, `/work/fix-typo-${id}`);
    assert.equal(run.env.GH_TOKEN, "ghp_token");
    assert.equal(run.env.DSH_SUPERAGENT_NAME, `fix-typo-${id}`);
    assert.equal(run.env.DSH_SUPERAGENT_TICKET, id);
    assert.ok(!run.systemPrompt.includes("ghp_token"));
    assert.equal(JSON.parse(run.messages[0]!).ticket_id, id);
    assert.equal(JSON.parse(run.messages[1]!).trigger_id, t.id);
    assert.deepEqual(run.tools.map((tool) => tool.name).sort(), world.worker(id).map((tool) => tool.name).sort());
    await call(run.tools, "orchestrator_report", { state: "progress", summary: "On it" });
    return "Finished my turn";
  });
  const { driver, workspace } = executorOf(world, runner);
  driver.tick();
  assert.equal(driver.running, 1);
  await driver.settle();
  assert.equal(workspace.prepared.length, 1);
  assert.equal(workspace.prepared[0]?.branch, `agent/fix-typo-${id}`);
  assert.equal(workspace.prepared[0]?.repository, "acme/app");
  const ticket = world.state.tickets.get(id)!;
  assert.equal(ticket.assignments[0]?.state, "running");
  assert.equal(ticket.undelivered.length, 0);
  assert.ok(ticket.assignments[0]?.idleAt, "its turn ended");
  assert.equal(ticketStage(ticket), "waiting");
  driver.tick();
  await driver.settle();
  assert.equal(runner.runs.length, 1, "an idle worker is not run again");
});

test("a person's comment wakes an idle worker with only the new messages", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  const runner = new ScriptedRunner();
  const { driver } = executorOf(world, runner);
  driver.tick();
  await driver.settle();
  const comment = trigger({ number: 1, text: "also fix the footer" });
  world.engine.receive(comment);
  world.engine.evaluateDue();
  assert.ok(world.state.tickets.get(id)!.undelivered.length > 0);
  driver.tick();
  await driver.settle();
  assert.equal(runner.runs.length, 2);
  assert.equal(runner.runs[1]!.messages.length, 1);
  assert.equal(JSON.parse(runner.runs[1]!.messages[0]!).trigger_id, comment.id);
  assert.equal(world.state.tickets.get(id)!.undelivered.length, 0);
});

test("a message followed only for context does not wake an idle worker, but rides along with the next wake", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  const runner = new ScriptedRunner();
  const { driver } = executorOf(world, runner);
  driver.tick();
  await driver.settle();
  await call(world.worker(id), "orchestrator_thread_follow", { thread: "github:5", reason: "related" });
  const context = trigger({ number: 5, text: "unrelated chatter", actor: { source: "github", id: "carol" } });
  world.engine.receive(context);
  world.engine.evaluateDue();
  driver.tick();
  await driver.settle();
  assert.equal(runner.runs.length, 1, "context alone does not wake it");
  world.engine.note(id, "Another ticket found the same typo");
  driver.tick();
  await driver.settle();
  assert.equal(runner.runs.length, 2);
  assert.ok(runner.runs[1]!.messages.length >= 2, "the context message was delivered with the note");
});

test("messages that arrive while the worker runs reach it through drain", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  const late = trigger({ number: 1, text: "one more thing" });
  const drained: string[][] = [];
  const runner = new ScriptedRunner(async (run) => {
    world.engine.receive(late);
    world.engine.evaluateDue();
    drained.push(run.drain());
    drained.push(run.drain());
  });
  const { driver } = executorOf(world, runner);
  driver.tick();
  await driver.settle();
  assert.equal(drained[0]?.length, 1);
  assert.deepEqual(drained[1], []);
  assert.equal(runner.runs.length, 1);
  assert.equal(world.state.tickets.get(id)!.undelivered.length, 0);
});

test("maxWorkers bounds the runs and a person's reply goes first", async () => {
  const world = agentsWorld(makeSettings({ executor: { maxWorkers: 1 } }));
  const a = await world.accept(request({ number: 1 }), "task-one");
  const b = await world.accept(request({ number: 2 }), "task-two");
  const order: string[] = [];
  const release: (() => void)[] = [];
  const runner = new ScriptedRunner(async (run) => {
    order.push(run.sessionId);
    await new Promise<void>((resolve) => release.push(resolve));
  });
  const { driver } = executorOf(world, runner);
  driver.tick();
  assert.equal(driver.running, 1);
  await waitFor(() => order.length === 1, "first worker started");
  assert.equal(order[0], a);
  driver.tick();
  assert.equal(driver.running, 1, "the second waits for a slot");
  release.shift()!();
  await driver.settle();
  driver.tick();
  await waitFor(() => order.length === 2, "second worker started");
  assert.equal(order[1], b);
  release.shift()!();
  await driver.settle();
  // Ticket b gets a person's reply and a's gets only a note: b runs first.
  world.engine.note(a, "fyi");
  const reply = trigger({ number: 2, text: "thanks, and the footer?" });
  world.engine.receive(reply);
  world.engine.evaluateDue();
  driver.tick();
  await waitFor(() => order.length === 3, "third run started");
  assert.equal(order[2], b);
  release.shift()!();
  await driver.settle();
});

test("a worker whose run fails is reported failed and a retry runs it again", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  const runner = new ScriptedRunner(() => {
    throw new AgentRunError("invalid api key", false);
  });
  const { driver } = executorOf(world, runner);
  driver.tick();
  await driver.settle();
  const ticket = world.state.tickets.get(id)!;
  assert.equal(ticketStage(ticket), "failed");
  assert.match(ticket.assignments[0]!.report!.summary, /invalid api key/);
  assert.ok(world.engine.pendingNotices().some((notice) => /failed/.test(notice.text)));
  driver.tick();
  await driver.settle();
  assert.equal(runner.runs.length, 1, "a failed ticket is not run again by itself");
  world.engine.retryTicket(id);
  runner.handler = () => "ok";
  driver.tick();
  await driver.settle();
  assert.equal(runner.runs.length, 2);
  assert.equal(JSON.parse(runner.runs[1]!.messages[0]!).assignment, 2);
  assert.match(runner.runs[1]!.messages.join("\n"), /retried/);
});

test("a worktree that cannot be prepared fails the assignment without running the agent", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  const workspace = new FakeWorkspace();
  workspace.failWith = "fetch failed";
  const runner = new ScriptedRunner();
  const { driver } = executorOf(world, runner, workspace);
  driver.tick();
  await driver.settle();
  assert.equal(runner.runs.length, 0);
  assert.match(world.state.tickets.get(id)!.assignments[0]!.report!.summary, /Could not prepare the worktree: fetch failed/);
});

test("stopping a ticket aborts its running worker", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  let aborted = false;
  const runner = new ScriptedRunner(
    (run) =>
      new Promise<void>((resolve) => {
        run.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      }),
  );
  const { driver } = executorOf(world, runner);
  driver.tick();
  await waitFor(() => runner.runs.length === 1, "worker started");
  world.engine.stopTicket(id);
  driver.tick();
  await driver.settle();
  assert.equal(aborted, true);
  assert.equal(world.state.tickets.get(id)!.ended?.outcome, "stopped");
  assert.equal(world.state.tickets.get(id)!.assignments[0]!.state, "ended");
});

test("a shutdown interrupts a running worker so the next start resumes it", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  const runner = new ScriptedRunner((run) => new Promise<void>((resolve) => run.signal.addEventListener("abort", () => resolve())));
  const { driver } = executorOf(world, runner);
  driver.tick();
  await waitFor(() => runner.runs.length === 1, "worker started");
  await driver.stop();
  assert.equal(world.state.tickets.get(id)!.assignments[0]!.state, "pending");
  runner.handler = () => "ok";
  const { driver: next } = executorOf(world, runner);
  next.tick();
  await next.settle();
  assert.equal(runner.runs.length, 2);
  assert.match(runner.runs[1]!.messages.join("\n"), /restarted/);
});

test("recover restarts a worker that was mid-turn but leaves a waiting one alone", async () => {
  const world = agentsWorld();
  const mid = await world.accept(request({ number: 1 }), "mid-turn");
  const waiting = await world.accept(request({ number: 2 }), "waiting-one");
  world.start(mid);
  world.start(waiting);
  world.engine.turnEnded(waiting, world.state.tickets.get(waiting)!.assignments[0]!.id, "done for now");
  const { driver } = executorOf(world, new ScriptedRunner());
  driver.recover();
  assert.equal(world.state.tickets.get(mid)!.assignments[0]!.state, "pending");
  assert.equal(world.state.tickets.get(waiting)!.assignments[0]!.state, "running");
});

test("transient run errors are retried before the worker is failed", async () => {
  const world = agentsWorld();
  const id = await world.accept(request());
  let attempts = 0;
  const runner = new ScriptedRunner((run) => {
    attempts += 1;
    if (attempts === 1) throw new Error("socket hang up");
    assert.match(run.messages[0]!, /temporary error/);
    return "recovered";
  });
  const { driver } = executorOf(world, runner);
  driver.tick();
  await driver.settle();
  assert.equal(attempts, 2);
  assert.equal(ticketStage(world.state.tickets.get(id)!), "waiting");
});

test("no worker starts without a token, an agent account, or while paused", async () => {
  const world = agentsWorld();
  await world.accept(request());
  const runner = new ScriptedRunner();
  const noToken = executorOf(world, runner, new FakeWorkspace(), null).driver;
  noToken.tick();
  const paused = executorOf(world, runner).driver;
  world.current.settings = makeSettings({ paused: true });
  paused.tick();
  await Promise.all([noToken.settle(), paused.settle()]);
  assert.equal(runner.runs.length, 0);
});
