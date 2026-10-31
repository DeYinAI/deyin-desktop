/**
 * The runner on the real agent loop: a scripted OpenAI-compatible server stands in for the model, everything else is real: the loop,
 * the built-in tools, the shell and its environment, the permission engine and the stored conversation.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createBuiltinRegistry } from "@deyin/agent-core";
import type { AgentRunRequest, AgentTool, Logger } from "@deyin/superagent";
import { AgentCoreRunner } from "../src/main/superagent/runner.js";

const silent: Logger = { info: () => undefined, warn: () => undefined };
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "superagent-loop-"));
  dirs.push(dir);
  return dir;
};

type Body = { messages: { role: string; content?: string; tool_calls?: unknown[] }[]; tools?: { function: { name: string } }[] };
type Reply = { text: string } | { call: { name: string; args: object } };

async function modelServer(script: (index: number, body: Body) => Reply) {
  const requests: Body[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
      const reply = script(requests.push(body) - 1, body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frames =
        "text" in reply
          ? [{ choices: [{ delta: { content: reply.text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]
          : [
              { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } }] } }] },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            ];
      for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const SECRET = "ghp_never_sent_to_the_model";

function runnerFor(url: string, sessionsDir: string, homeDir: string) {
  return new AgentCoreRunner({
    sessionsDir,
    homeDir,
    logger: silent,
    saveDebounceMs: 5,
    defaultModel: () => ({ providerId: "test", model: "scripted" }),
    route: () => ({ apiBaseUrl: url, getToken: async () => "model-key" }),
    contextLength: () => undefined,
    options: () => ({ maxSteps: 20, thinking: false }),
    builtinTools: () => createBuiltinRegistry(),
  });
}

const worker = (cwd: string, patch: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  role: "worker",
  sessionId: "t1",
  systemPrompt: "You are a worker.",
  tools: [],
  cwd,
  env: { GH_TOKEN: SECRET },
  blockedCommands: [],
  model: null,
  messages: ["Fix the typo."],
  drain: () => [],
  signal: new AbortController().signal,
  ...patch,
});

test("a worker's shell sees its credentials, its files stay in its directory, and the model never sees the token", async () => {
  const root = tempDir();
  const cwd = join(root, "ticket");
  mkdirSync(cwd);
  const steps: Reply[] = [
    { call: { name: "bash", args: { command: 'printf "%s" "$GH_TOKEN" > who.txt && echo ok' } } },
    { call: { name: "write", args: { path: "../escaped.txt", content: "no" } } },
    { call: { name: "write", args: { path: "fix.txt", content: "fixed\n" } } },
    { text: "All done." },
  ];
  const model = await modelServer((index) => steps[index]!);
  try {
    const runner = runnerFor(model.url, join(root, "sessions"), root);
    const out = await runner.run(worker(cwd));
    assert.equal(out.finalText, "All done.");
    assert.equal(readFileSync(join(cwd, "who.txt"), "utf8"), SECRET, "the shell has the credentials");
    assert.equal(readFileSync(join(cwd, "fix.txt"), "utf8"), "fixed\n");
    assert.equal(existsSync(join(root, "escaped.txt")), false, "a write outside the ticket directory is refused");
    for (const request of model.requests) assert.ok(!JSON.stringify(request).includes(SECRET), "the token must never be part of a prompt");
    assert.match(model.requests[0]!.messages[0]!.content ?? "", /^You are a worker\.[\s\S]*runs unattended/);
    // The shell, file and search tools are offered; nothing that needs a person.
    const offered = (model.requests[0]!.tools ?? []).map((tool) => tool.function.name);
    assert.ok(offered.includes("bash") && offered.includes("edit"));
    assert.ok(!offered.includes("ask_question"));
  } finally {
    await model.close();
  }
});

test("a blocked command is refused to the model, and the rest of the run goes on", async () => {
  const root = tempDir();
  const cwd = join(root, "ticket");
  mkdirSync(cwd);
  const steps: Reply[] = [
    { call: { name: "bash", args: { command: "echo keep > keep.txt" } } },
    { call: { name: "bash", args: { command: "echo hi && rm keep.txt" } } },
    { text: "Stopped." },
  ];
  const model = await modelServer((index) => steps[index]!);
  try {
    await runnerFor(model.url, join(root, "sessions"), root).run(worker(cwd, { blockedCommands: ["rm"] }));
    assert.equal(readFileSync(join(cwd, "keep.txt"), "utf8"), "keep\n", "the blocked command never ran");
    const refusal = model.requests[2]!.messages.filter((message) => message.role === "tool").at(-1)?.content ?? "";
    assert.match(refusal, /"rm" is blocked by the Superagent settings/);
  } finally {
    await model.close();
  }
});

test("the domain tools are called by the model, and a message that arrives mid-run reaches it at the next step", async () => {
  const root = tempDir();
  const cwd = join(root, "ticket");
  mkdirSync(cwd);
  const reports: unknown[] = [];
  const report: AgentTool = {
    name: "orchestrator_report",
    description: "Report progress",
    parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    execute: async (args) => (reports.push(args), { recorded: true }),
  };
  const inbox: string[][] = [["Please also check the docs."]];
  const steps: Reply[] = [{ call: { name: "orchestrator_report", args: { summary: "started" } } }, { text: "Reported." }];
  const model = await modelServer((index) => steps[index]!);
  try {
    const out = await runnerFor(model.url, join(root, "sessions"), root).run(worker(cwd, { tools: [report], drain: () => inbox.shift() ?? [] }));
    assert.equal(out.finalText, "Reported.");
    assert.deepEqual(reports, [{ summary: "started" }]);
    const toolResult = model.requests[1]!.messages.filter((message) => message.role === "tool").at(-1)?.content ?? "";
    assert.equal(toolResult, '{"recorded":true}');
    // The arrival was picked up before the model's next step; it is part of the conversation from there on.
    assert.ok(model.requests.some((request) => request.messages.some((message) => message.role === "user" && message.content === "Please also check the docs.")));
  } finally {
    await model.close();
  }
});

test("the next run of a ticket continues the conversation, and an orchestrator is offered nothing but its tools", async () => {
  const root = tempDir();
  const cwd = join(root, "ticket");
  mkdirSync(cwd);
  const sessionsDir = join(root, "sessions");
  const first = await modelServer(() => ({ text: "First answer." }));
  try {
    await runnerFor(first.url, sessionsDir, root).run(worker(cwd, { messages: ["First request."] }));
  } finally {
    await first.close();
  }

  const second = await modelServer(() => ({ text: "Second answer." }));
  try {
    await runnerFor(second.url, sessionsDir, root).run(worker(cwd, { messages: ["A person wrote a follow-up."], systemPrompt: "Updated prompt." }));
    const sent = second.requests[0]!.messages;
    assert.deepEqual(sent.map((message) => message.role), ["system", "user", "assistant", "user"]);
    assert.ok(sent[0]!.content?.startsWith("Updated prompt."), "the current system prompt applies");
    assert.deepEqual(sent.slice(1).map((message) => message.content), ["First request.", "First answer.", "A person wrote a follow-up."]);
  } finally {
    await second.close();
  }

  const route: AgentTool = { name: "orchestrator_route", description: "Route", parameters: { type: "object", properties: {} }, execute: async () => "routed" };
  const third = await modelServer((index) => (index === 0 ? { call: { name: "orchestrator_route", args: {} } } : { text: "Routed." }));
  try {
    await runnerFor(third.url, sessionsDir, root).run({ ...worker(cwd), role: "orchestrator", sessionId: "orchestrator", cwd: undefined, env: {}, tools: [route] });
    assert.deepEqual((third.requests[0]!.tools ?? []).map((tool) => tool.function.name), ["orchestrator_route"]);
  } finally {
    await third.close();
  }
});

test("a model that cannot be reached is reported, and an aborted run ends without an error", async () => {
  const root = tempDir();
  const cwd = join(root, "ticket");
  mkdirSync(cwd);
  const unreachable = runnerFor("http://127.0.0.1:1/v1", join(root, "sessions"), root);
  await assert.rejects(unreachable.run(worker(cwd)));

  const model = await modelServer(() => ({ text: "never read" }));
  try {
    const controller = new AbortController();
    controller.abort();
    const out = await runnerFor(model.url, join(root, "sessions"), root).run(worker(cwd, { signal: controller.signal }));
    assert.equal(out.finalText, "");
  } finally {
    await model.close();
  }
});
