import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolRegistry, type ToolContext, type ToolDefinition } from "@deyin/agent-core";
import { REDACTED } from "@deyin/host-core";
import { redactTool, redactToolResults } from "../src/main/bots/vault-redaction.js";
import { browserPageSource, chromePageSource, vaultPageOf } from "../src/main/bots/vault-pages.js";

const SECRET = "4242424242424242";
const CTX = { cwd: "/tmp", todos: [] } as ToolContext;

function tool(name: string, execute: ToolDefinition["execute"]): ToolDefinition {
  return { name, description: `${name} tool`, parameters: { type: "object", properties: {} }, tier: "read", summarize: () => name, execute };
}

test("a result is scrubbed of every saved secret, and the rest of it is left alone", async () => {
  const wrapped = redactTool(tool("browser_snapshot", async () => `textbox "Card number" value="${SECRET}"\nbutton "Pay"`), () => [SECRET]);
  assert.equal(await wrapped.execute({}, CTX), `textbox "Card number" value="${REDACTED}"\nbutton "Pay"`);
});

test("the tool is otherwise unchanged", () => {
  const original = tool("t", async () => "x");
  const wrapped = redactTool(original, () => [SECRET]);
  assert.equal(wrapped.name, original.name);
  assert.equal(wrapped.description, original.description);
  assert.equal(wrapped.tier, original.tier);
  assert.equal(wrapped.parameters, original.parameters);
  assert.equal(wrapped.summarize({}), "t");
});

test("the secrets are read on every call, so a newly saved one is hidden at once", async () => {
  let secrets: string[] = [];
  const wrapped = redactTool(tool("t", async () => `value ${SECRET}`), () => secrets);
  assert.equal(await wrapped.execute({}, CTX), `value ${SECRET}`);
  secrets = [SECRET];
  assert.equal(await wrapped.execute({}, CTX), `value ${REDACTED}`);
});

test("arguments and context reach the tool unchanged", async () => {
  let seen: { args: unknown; cwd: unknown } | null = null;
  const wrapped = redactTool(
    tool("t", async (args, ctx) => {
      seen = { args, cwd: ctx.cwd };
      return "ok";
    }),
    () => [SECRET],
  );
  await wrapped.execute({ a: 1 }, CTX);
  assert.deepEqual(seen, { args: { a: 1 }, cwd: "/tmp" });
});

test("streamed output is scrubbed too, while it is still coming", async () => {
  const deltas: string[] = [];
  const wrapped = redactTool(
    tool("bash", async (_args, ctx) => {
      ctx.onOutput?.(`echo ${SECRET}\n`);
      ctx.onOutput?.("done\n");
      return "done";
    }),
    () => [SECRET],
  );
  await wrapped.execute({}, { ...CTX, onOutput: (delta) => deltas.push(delta) });
  assert.deepEqual(deltas, [`echo ${REDACTED}\n`, "done\n"]);
});

test("a tool with nobody listening for output still runs", async () => {
  const wrapped = redactTool(tool("bash", async (_args, ctx) => (ctx.onOutput ? "listening" : "alone")), () => [SECRET]);
  assert.equal(await wrapped.execute({}, CTX), "alone");
});

test("an error message is scrubbed, and the failure is kept", async () => {
  const wrapped = redactTool(
    tool("t", async () => {
      throw new Error(`could not type ${SECRET}`);
    }),
    () => [SECRET],
  );
  await assert.rejects(wrapped.execute({}, CTX), (error: Error) => error.message === `could not type ${REDACTED}`);
  const plain = redactTool(
    tool("t", async () => {
      throw "just text";
    }),
    () => [SECRET],
  );
  await assert.rejects(plain.execute({}, CTX), (error: Error) => error.message === "just text");
});

test("every tool in a registry is covered, whatever it is", async () => {
  const registry = new ToolRegistry();
  registry.register(tool("browser_evaluate", async () => `document.value=${SECRET}`));
  registry.register(tool("bash", async () => `cat card.txt -> ${SECRET}`));
  registry.register(tool("mcp__gmail__read", async () => `mail mentions ${SECRET}`));
  redactToolResults(registry, () => [SECRET]);
  assert.deepEqual(registry.names().sort(), ["bash", "browser_evaluate", "mcp__gmail__read"]);
  for (const name of registry.names()) {
    const out = await registry.get(name)?.execute({}, CTX);
    assert.equal(out?.includes(SECRET), false, name);
    assert.equal(out?.includes(REDACTED), true, name);
  }
});

/* The page adapters ---------------------------------------------------------- */

function fakeDriver() {
  const calls: string[] = [];
  return {
    calls,
    info: async () => ({ url: "https://github.com/login", title: "Sign in" }),
    // The real driver answers with what it typed; the adapter must not pass that on.
    fill: async (ref: string, value: string) => {
      calls.push(`fill ${ref} ${value}`);
      return `Filled ${ref} with "${value}"`;
    },
    press: async (key: string) => {
      calls.push(`press ${key}`);
      return `Pressed ${key}`;
    },
  };
}

test("a page's address is read, a field is filled without echoing it, and submit is Enter", async () => {
  const driver = fakeDriver();
  const page = vaultPageOf(driver);
  assert.equal(await page.url(), "https://github.com/login");
  assert.equal(await page.fill("e2", "hunter2"), undefined);
  assert.equal(await page.submit(), undefined);
  assert.deepEqual(driver.calls, ["fill e2 hunter2", "press Enter"]);
});

test("the in-app browser's page is the one filled", async () => {
  const driver = fakeDriver();
  const source = browserPageSource({ withPage: (fn) => fn(driver as never) });
  const url = await source.withPage(CTX, (page) => page.url());
  assert.equal(url, "https://github.com/login");
});

test("Chrome's page is the Bot's current tab for this conversation, and the run's cancel signal goes with it", async () => {
  const driver = fakeDriver();
  let seen: { thread: string | undefined; tab: number | undefined; action: string; signal: AbortSignal | undefined } | null = null;
  const source = chromePageSource({
    withPage: async (thread, tab, action, fn, opts) => {
      seen = { thread, tab, action, signal: opts?.signal };
      return fn(driver as never);
    },
  });
  const abort = new AbortController();
  await source.withPage({ ...CTX, signal: abort.signal, sessionMeta: { threadId: "t-1" } } as ToolContext, (page) => page.fill("e1", "x"));
  assert.deepEqual(seen, { thread: "t-1", tab: undefined, action: "fill", signal: abort.signal });
  await source.withPage(CTX, (page) => page.url());
  assert.equal((seen as { signal: unknown } | null)?.signal, undefined);
});
