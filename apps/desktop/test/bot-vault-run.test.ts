import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolRegistry, type ToolContext, type ToolDefinition } from "@deyin/agent-core";
import { REDACTED, type VaultItem } from "@deyin/host-core/shared";
import { createVaultRun, type VaultRunPeople } from "../src/main/bots/vault-run.js";
import type { VaultPage, VaultPageSource } from "../src/main/bots/vault-tools.js";

const CTX = { cwd: "/tmp", todos: [] } as ToolContext;
const LOGIN: VaultItem = { id: "i1", kind: "login", title: "GitHub", notes: "", createdAt: 1, updatedAt: 1, username: "ada", sites: ["github.com"], hasPassword: true };

function vault(secrets: string[] = []) {
  const grants = new Set<string>();
  return {
    list: () => [LOGIN],
    get: (id: string) => (id === LOGIN.id ? LOGIN : null),
    field: (_id: string, field: string) => (field === "password" ? "hunter2hunter2" : field === "username" ? "ada" : null),
    hasGrant: (bot: string, item: string, host: string) => grants.has(`${bot}/${item}/${host}`),
    grant: (bot: string, item: string, host: string) => void grants.add(`${bot}/${item}/${host}`),
    addSite: () => true,
    secretValues: () => secrets,
  };
}

const page: VaultPage = { url: async () => "https://github.com/login", fill: async () => undefined, submit: async () => undefined };
const source: VaultPageSource = { withPage: (_ctx, fn) => fn(page) };

const people = (over: Partial<VaultRunPeople> = {}): VaultRunPeople => ({
  ask: async () => "allow",
  takeover: async () => "done",
  secureForm: async () => ({ code: "123456" }),
  ...over,
});

const names = (tools: ToolDefinition[]): string[] => tools.map((tool) => tool.name).sort();

function plain(name: string, text: () => string): ToolDefinition {
  return { name, description: name, parameters: { type: "object", properties: {} }, tier: "read", summarize: () => name, execute: async () => text() };
}

test("a run with a browser gets the Vault tools, and one without gets none", () => {
  const withBrowser = createVaultRun({ vault: vault(), botId: "b", pages: { browser: source }, people: people() });
  assert.deepEqual(names(withBrowser.tools()), ["request_takeover", "secure_form_fill", "vault_fill", "vault_list"]);
  const without = createVaultRun({ vault: vault(), botId: "b", pages: {}, people: people() });
  assert.deepEqual(without.tools(), []);
});

test("a run nobody watches can fill what was agreed, and cannot ask for more", async () => {
  const run = createVaultRun({ vault: vault(), botId: "b", pages: { browser: source } });
  const fill = run.tools().find((tool) => tool.name === "vault_fill")!;
  const args = { entry: "i1", fields: [{ field: "username", ref: "e1" }] };
  assert.match(await fill.execute(args, CTX), /^ERROR: .*nobody is here/i);
  const takeover = run.tools().find((tool) => tool.name === "request_takeover")!;
  assert.match(await takeover.execute({ reason: "captcha" }, CTX), /^ERROR: Nobody is here to take over/);
  const form = run.tools().find((tool) => tool.name === "secure_form_fill")!;
  assert.match(await form.execute({ title: "Code", fields: [{ id: "c", label: "Code", ref: "e1" }] }, CTX), /^ERROR: Nobody is here to fill in a form/);
  // What was agreed before is still usable.
  const agreed = vault();
  agreed.grant("b", "i1", "github.com");
  const later = createVaultRun({ vault: agreed, botId: "b", pages: { browser: source } });
  const again = later.tools().find((tool) => tool.name === "vault_fill")!;
  assert.match(await again.execute(args, CTX), /Filled username/);
});

test("a person who is there is asked, and the agreement is remembered for this Bot", async () => {
  const asked: string[] = [];
  const store = vault();
  const run = createVaultRun({
    vault: store,
    botId: "b",
    pages: { browser: source },
    people: people({
      ask: async (request) => {
        asked.push(request.summary);
        return "allow-always";
      },
    }),
  });
  const fill = run.tools().find((tool) => tool.name === "vault_fill")!;
  const args = { entry: "i1", fields: [{ field: "username", ref: "e1" }] };
  assert.match(await fill.execute(args, CTX), /Filled username/);
  assert.match(await fill.execute(args, CTX), /Filled username/);
  assert.equal(asked.length, 1);
  assert.equal(store.hasGrant("b", "i1", "github.com"), true);
  assert.equal(store.hasGrant("other", "i1", "github.com"), false);
});

test("a person who is there can be asked to take over", async () => {
  const reasons: string[] = [];
  const run = createVaultRun({
    vault: vault(),
    botId: "b",
    pages: { browser: source },
    people: people({
      takeover: async (reason) => {
        reasons.push(reason);
        return "done";
      },
    }),
  });
  const takeover = run.tools().find((tool) => tool.name === "request_takeover")!;
  assert.match(await takeover.execute({ reason: "Solve the captcha" }, CTX), /^(?!ERROR)/);
  assert.deepEqual(reasons, ["Solve the captcha"]);
});

test("a subagent only has the tools its list names, and only for the in-app browser", () => {
  const run = createVaultRun({ vault: vault(), botId: "b", pages: { browser: source, chrome: source }, people: people() });
  assert.deepEqual(run.subagentTools(undefined), []);
  assert.deepEqual(run.subagentTools([]), []);
  assert.deepEqual(run.subagentTools(["bash", "read"]), []);
  assert.deepEqual(names(run.subagentTools(["vault_fill", "vault_list", "bash"])), ["vault_fill", "vault_list"]);
  const chromeOnly = createVaultRun({ vault: vault(), botId: "b", pages: { chrome: source }, people: people() });
  assert.deepEqual(chromeOnly.subagentTools(["vault_fill"]), []);
  // With only the in-app browser in play, the tool has no `surface` choice to make.
  const only = run.subagentTools(["vault_fill"])[0]!;
  assert.equal("surface" in (only.parameters as { properties: Record<string, unknown> }).properties, false);
});

test("saved secrets are scrubbed from every tool in a registry", async () => {
  const run = createVaultRun({ vault: vault(["4242424242424242"]), botId: "b", pages: {} });
  const registry = new ToolRegistry();
  registry.register(plain("browser_snapshot", () => 'textbox "Card" value="4242424242424242"'));
  run.protect(registry);
  assert.equal(await registry.get("browser_snapshot")!.execute({}, CTX), `textbox "Card" value="${REDACTED}"`);
});

test("what a person typed into a Secure Form is hidden from then on, and was not saved anywhere", async () => {
  const store = vault();
  const run = createVaultRun({ vault: store, botId: "b", pages: { browser: source }, people: people({ secureForm: async () => ({ code: "834201" }) }) });
  const registry = new ToolRegistry();
  for (const tool of run.tools()) registry.register(tool);
  registry.register(plain("browser_snapshot", () => "textbox value=834201"));
  run.protect(registry);
  assert.equal(await registry.get("browser_snapshot")!.execute({}, CTX), "textbox value=834201", "nothing typed yet");
  const form = registry.get("secure_form_fill")!;
  await form.execute({ title: "Sign-in code", fields: [{ id: "code", label: "Code", ref: "e5" }] }, CTX);
  assert.equal(await registry.get("browser_snapshot")!.execute({}, CTX), `textbox value=${REDACTED}`);
  assert.deepEqual(store.secretValues(), [], "the Vault itself is unchanged");
  assert.deepEqual([...run.secrets()], ["834201"]);
});

test("what one run's person typed is not hidden in another run", () => {
  const first = createVaultRun({ vault: vault(), botId: "b", pages: { browser: source }, people: people() });
  const second = createVaultRun({ vault: vault(), botId: "b", pages: { browser: source }, people: people() });
  void first.tools();
  assert.deepEqual([...second.secrets()], []);
});

test("secrets saved after the run began are hidden at once", async () => {
  const secrets: string[] = [];
  const run = createVaultRun({ vault: vault(secrets), botId: "b", pages: {} });
  const registry = new ToolRegistry();
  registry.register(plain("t", () => "number 4242424242424242"));
  run.protect(registry);
  assert.equal(await registry.get("t")!.execute({}, CTX), "number 4242424242424242");
  secrets.push("4242424242424242");
  assert.equal(await registry.get("t")!.execute({}, CTX), `number ${REDACTED}`);
});

/* 1Password ---------------------------------------------------------------------------------------------------------- */

const OP_ID = "abcdefghijklmnopqrstuvwxyz";
const OP_PASSWORD = "op-secret-password-123";
const onePassword = {
  logins: async () => [{ id: OP_ID, title: "GitHub", username: "ada", sites: ["github.com"] }],
  credential: async () => ({ username: "ada", password: OP_PASSWORD }),
};

test("1Password tools are offered only when it is turned on, and only to a run with a browser", () => {
  const off = createVaultRun({ vault: vault(), botId: "b", pages: { browser: source }, people: people() });
  assert.ok(!names(off.tools()).some((name) => name.startsWith("onepassword")));
  const on = createVaultRun({ vault: vault(), botId: "b", pages: { browser: source }, people: people(), onePassword });
  assert.deepEqual(names(on.tools()), ["onepassword_fill", "onepassword_list", "request_takeover", "secure_form_fill", "vault_fill", "vault_list"]);
  const noBrowser = createVaultRun({ vault: vault(), botId: "b", pages: {}, people: people(), onePassword });
  assert.deepEqual(noBrowser.tools(), []);
});

test("a subagent gets the 1Password tools only when its tool list names them", () => {
  const run = createVaultRun({ vault: vault(), botId: "b", pages: { browser: source }, people: people(), onePassword });
  assert.deepEqual(names(run.subagentTools(["onepassword_list"])), ["onepassword_list"]);
  assert.deepEqual(run.subagentTools(["vault_list"]).map((tool) => tool.name), ["vault_list"]);
  assert.deepEqual(run.subagentTools(undefined), []);
});

test("a password read from 1Password is scrubbed from everything the Bot reads afterwards", async () => {
  const run = createVaultRun({ vault: vault(), botId: "b", pages: { browser: source }, people: people(), onePassword });
  assert.ok(!run.secrets().includes(OP_PASSWORD), "nothing is held before it is read");
  const fill = run.tools().find((tool) => tool.name === "onepassword_fill")!;
  await fill.execute({ entry: OP_ID, fields: [{ ref: "e1", field: "password" }] }, CTX);
  assert.ok(run.secrets().includes(OP_PASSWORD));
  const registry = new ToolRegistry();
  registry.register(plain("page_text", () => `The page echoed ${OP_PASSWORD} back`));
  run.protect(registry);
  const text = await registry.get("page_text")!.execute({}, CTX);
  assert.ok(!String(text).includes(OP_PASSWORD), String(text));
  assert.ok(String(text).includes(REDACTED));
});

test("with nobody to ask, the 1Password tools refuse, so nothing is ever read", async () => {
  let read = 0;
  const watching = { ...onePassword, credential: async () => (read++, { username: "ada", password: OP_PASSWORD }) };
  const run = createVaultRun({ vault: vault(), botId: "b", pages: { browser: source }, onePassword: watching });
  const fill = run.tools().find((tool) => tool.name === "onepassword_fill")!;
  assert.match(String(await fill.execute({ entry: OP_ID, fields: [{ ref: "e1", field: "password" }] }, CTX)), /^ERROR: .*nobody is here/i);
  assert.equal(read, 0);
});
