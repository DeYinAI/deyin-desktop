import assert from "node:assert/strict";
import test from "node:test";
import type { Automation } from "@deyin/host-core";
import { createAutomationTools } from "../src/main/automation-tools.js";
import type { AutomationService } from "../src/main/automations/service.js";

const ctx = {} as never;
const settings = { get: () => ({ defaultModel: "openference::m" }) } as never;

function existing(patch: Partial<Automation> = {}): Automation {
  return {
    id: "a1",
    name: "X",
    enabled: true,
    payload: { kind: "prompt", prompt: "p" },
    trigger: { kind: "manual" },
    target: { kind: "local", workspacePath: "/w" },
    model: "m",
    providerId: "openference",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function setup(current: Automation = existing()) {
  const created: Array<Record<string, unknown>> = [];
  const patches: Array<Record<string, unknown>> = [];
  let live = current;
  const service = {
    create: (input: Record<string, unknown>) => {
      created.push(input);
      return { automation: { ...input, id: "a2", trigger: { kind: "manual" } } };
    },
    update: (_id: string, patch: Record<string, unknown>) => {
      patches.push(patch);
      live = { ...live, ...patch } as Automation;
    },
    list: () => [live],
  } as unknown as AutomationService;
  const find = (name: string) => createAutomationTools(service, settings).find((t) => t.name === name)!;
  return { created, patches, find };
}

const base = { name: "N", prompt: "p", workspacePath: "/w" };

/* Browser consent --------------------------------------------------------------------------- */

test("browser sites are stored as normalized, de-duplicated origins; none given means none stored", async () => {
  const t = setup();
  await t.find("automation_create").execute({ ...base, browserSites: ["x.com", "https://x.com/home", " https://chatgpt.com "] }, ctx);
  assert.deepEqual(t.created[0]?.consent, { browserOrigins: ["https://x.com", "https://chatgpt.com"] });

  await t.find("automation_create").execute(base, ctx);
  assert.equal("consent" in (t.created[1] ?? {}), false, "no grant unless one was asked for");
  await t.find("automation_create").execute({ ...base, browserSites: [] }, ctx);
  assert.equal("consent" in (t.created[2] ?? {}), false, "an empty list on create grants nothing");
});

test("something that is not a site is refused, so a typo can never become a grant", async () => {
  const t = setup();
  for (const browserSites of [["javascript:alert(1)"], ["x.com", "intranet"], ["file:///etc/passwd"], "x.com", [42]]) {
    await assert.rejects(t.find("automation_create").execute({ ...base, browserSites }, ctx), /not a site|list of strings/, JSON.stringify(browserSites));
  }
  assert.equal(t.created.length, 0);
});

test("updating the sites replaces them, and an empty list withdraws Chrome access", async () => {
  const t = setup(existing({ consent: { browserOrigins: ["https://x.com"] } }));
  await t.find("automation_update").execute({ id: "a1", browserSites: ["https://openference.com"] }, ctx);
  assert.deepEqual(t.patches[0]?.consent, { browserOrigins: ["https://openference.com"] });
  await t.find("automation_update").execute({ id: "a1", browserSites: [] }, ctx);
  assert.deepEqual(t.patches[1]?.consent, { browserOrigins: [] });
  const untouched = await t.find("automation_update").execute({ id: "a1", name: "Renamed" }, ctx);
  assert.equal("consent" in (t.patches[2] ?? {}), false, "an update that does not mention the sites leaves them alone");
  assert.match(untouched, /Updated/);
});

test("required tools are kept alongside what the automation already declared", async () => {
  const t = setup(existing({ requires: { tools: ["bash"], exclusive: ["browser"] } }));
  await t.find("automation_create").execute({ ...base, requiredTools: ["chrome_*"] }, ctx);
  assert.deepEqual(t.created[0]?.requires, { tools: ["chrome_*"] });
  await t.find("automation_update").execute({ id: "a1", requiredTools: ["chrome_*"] }, ctx);
  assert.deepEqual(t.patches[0]?.requires, { tools: ["chrome_*"], exclusive: ["browser"] });
});

test("whoever approves the call sees what it grants", () => {
  const t = setup();
  const create = t.find("automation_create");
  assert.equal(create.summarize({ name: "X agent" }), "create automation X agent");
  assert.equal(create.summarize({ name: "X agent", browserSites: ["https://x.com", "https://chatgpt.com"] }), "create automation X agent — grants Chrome access to https://x.com, https://chatgpt.com");
  assert.match(t.find("automation_update").summarize({ id: "a1", browserSites: ["x.com"] }), /grants Chrome access to x\.com/);
  assert.doesNotMatch(t.find("automation_update").summarize({ id: "a1", browserSites: [] }), /grants/, "withdrawing access is not a grant");
});

test("the tool descriptions warn that a site is a grant to act as the user", () => {
  const description = JSON.stringify(setup().find("automation_create").parameters);
  assert.match(description, /ask the user before adding one/);
});

/* Self-healing ------------------------------------------------------------------------------ */

test("self-healing is on unless it is turned off, and can be turned back on", async () => {
  const t = setup(existing({ autoHeal: false }));
  await t.find("automation_create").execute(base, ctx);
  assert.equal("autoHeal" in (t.created[0] ?? {}), false, "the default is on, and is not stored");
  await t.find("automation_create").execute({ ...base, autoHeal: false }, ctx);
  assert.equal(t.created[1]?.autoHeal, false);
  await t.find("automation_update").execute({ id: "a1", autoHeal: true }, ctx);
  assert.equal(t.patches[0]?.autoHeal, true);
});

/* What a listing says ----------------------------------------------------------------------- */

test("a listing mentions the sites, the learned rules and whether a patch is still being judged", async () => {
  const revision = { id: "v", at: 1, runId: "r", signature: "s", rationale: "r", added: ["a"], removed: [], previousRules: [], baselineFailures: 0 };
  const t = setup(
    existing({
      consent: { browserOrigins: ["https://x.com"] },
      learnedRules: ["Wait for the composer before typing."],
      learnedRevisions: [{ ...revision, status: "probation" }],
    }),
  );
  const line = await t.find("automation_update").execute({ id: "a1", name: "X" }, ctx);
  assert.match(line, /may use Chrome on https:\/\/x\.com/);
  assert.match(line, /1 learned rule \(latest patch on probation\)/);

  const off = setup(existing({ autoHeal: false, learnedRules: ["One.  ", "Two.  "] as never }));
  assert.match(await off.find("automation_update").execute({ id: "a1", name: "X" }, ctx), /self-healing off, 2 learned rules/);

  const plain = setup();
  const quiet = await plain.find("automation_update").execute({ id: "a1", name: "X" }, ctx);
  assert.doesNotMatch(quiet, /Chrome|learned|self-healing/, "nothing to say, nothing said");
});
