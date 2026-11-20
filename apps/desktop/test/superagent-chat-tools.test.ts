import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_COMMANDS, BUILTIN_SKILLS, type ToolDefinition } from "@deyin/agent-core";
import type { SuperagentReply, SuperagentVerification } from "@deyin/contract";
import { defaultSettings, parseSettings, setupGaps, type Settings, type SuperagentView } from "@deyin/superagent";
import { createSuperagentChatTools, type SuperagentChatPort } from "../src/main/superagent-chat-tools.js";
import type { DeviceAuthorization } from "../src/main/superagent/github-device-flow.js";
import type { DeviceFlowOutcome } from "../src/main/superagent/service.js";

const CTX = {} as never;
const SECRET = "gho_THIS_MUST_NEVER_APPEAR_0123456789";

/** Superagent as far as the tools can tell: real settings validation and setup gaps, a scripted GitHub. */
class FakePort implements SuperagentChatPort {
  settings: Settings = defaultSettings();
  revision = 1;
  login: string | null = null;
  deviceFlow = true;
  /** Whether the person has approved the code yet. */
  approved = false;
  canPush = true;
  saves = 0;
  cleared = 0;
  /** Held here the way the service holds it: nothing the tools can reach exposes it. */
  private readonly token = SECRET;

  view(): SuperagentView {
    const { settings } = this;
    const gaps = setupGaps(settings, { hasToken: this.login !== null, ...(this.login ? { login: this.login } : {}) });
    return {
      revision: 1,
      status: {
        enabled: settings.enabled,
        paused: settings.paused,
        mode: settings.eval.mode,
        ready: gaps.length === 0,
        gaps,
        repository: settings.github.repository,
        account: this.login ? { login: this.login } : null,
        accountError: null,
        poll: { at: null, error: null },
        orchestrator: { running: false },
        workers: { running: 0, max: settings.executor.maxWorkers },
        storeError: null,
      },
      settings,
      settingsRevision: this.revision,
      tickets: [],
      candidates: [],
      decisions: [],
      receipts: [],
    };
  }

  current(): SuperagentReply {
    return { ok: true, value: this.view() };
  }

  async saveSettings(raw: unknown, baseRevision: number): Promise<SuperagentReply> {
    if (baseRevision !== this.revision) return { ok: false, error: "Settings changed since they were read; reload and try again" };
    try {
      this.settings = parseSettings(raw);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.revision++;
    this.saves++;
    return this.current();
  }

  async verify(): Promise<SuperagentReply<SuperagentVerification>> {
    if (!this.login) return { ok: false, error: "No GitHub token is stored" };
    return { ok: true, value: { login: this.login, canPush: this.canPush, repository: this.settings.github.repository } };
  }

  async clearToken(): Promise<SuperagentReply> {
    this.login = null;
    this.cleared++;
    return this.current();
  }

  deviceFlowAvailable(): boolean {
    return this.deviceFlow;
  }

  async beginDeviceFlow(): Promise<SuperagentReply<DeviceAuthorization>> {
    return { ok: true, value: { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresInSeconds: 900 } };
  }

  async finishDeviceFlow(): Promise<SuperagentReply<DeviceFlowOutcome>> {
    if (!this.approved) return { ok: true, value: { pending: true } };
    assert.ok(this.token.length > 0);
    this.login = "agent-bot";
    return { ok: true, value: { pending: false, view: this.view() } };
  }
}

function tools(port: FakePort): Record<string, ToolDefinition> {
  return Object.fromEntries(createSuperagentChatTools(port).map((tool) => [tool.name, tool]));
}

async function call(port: FakePort, name: string, args: Record<string, unknown> = {}): Promise<string> {
  return tools(port)[name]!.execute(args, CTX);
}

/** A port that is ready to run, in observe mode, watching nothing. */
function readyPort(): FakePort {
  const port = new FakePort();
  port.login = "agent-bot";
  port.settings = parseSettings({
    ...port.settings,
    github: { ...port.settings.github, repository: "acme/app" },
    policy: { ...port.settings.policy, sources: { github: { allowed: [{ id: "alice" }], bots: [], admission: {} } } },
  });
  return port;
}

const statusOf = async (port: FakePort): Promise<Record<string, unknown>> => JSON.parse(await call(port, "superagent_status")) as Record<string, unknown>;

/** Every property name in a JSON schema, however deeply it is nested. */
function propertyNames(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const names: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const [name, child] of Object.entries(value)) names.push(name, ...propertyNames(child));
    } else {
      names.push(...propertyNames(value));
    }
  }
  return names;
}

test("the six tools exist, and only the ones that look or verify are read-only", () => {
  const registered = tools(new FakePort());
  assert.deepEqual(Object.keys(registered).sort(), [
    "superagent_configure",
    "superagent_connect_github",
    "superagent_disconnect",
    "superagent_set_state",
    "superagent_status",
    "superagent_verify",
  ]);
  assert.equal(registered.superagent_status!.tier, "read");
  assert.equal(registered.superagent_verify!.tier, "read");
  for (const name of ["superagent_configure", "superagent_connect_github", "superagent_set_state", "superagent_disconnect"]) {
    assert.equal(registered[name]!.tier, "write", `${name} changes what Superagent may do, so it is not silent`);
  }
});

test("no tool has a parameter that could carry a token, password or key", () => {
  for (const tool of createSuperagentChatTools(new FakePort())) {
    for (const name of propertyNames(tool.parameters)) {
      assert.doesNotMatch(name, /token|secret|password|passwd|credential|api_?key|\bpat\b/i, `${tool.name} takes "${name}"`);
    }
  }
});

test("an argument a tool does not declare is refused by name, and a secret-looking one says never to send it", async () => {
  const port = new FakePort();
  for (const name of Object.keys(tools(port))) {
    const out = await call(port, name, { token: SECRET });
    assert.match(out, /^ERROR: /, name);
    assert.match(out, /does not take a token, password or key/, name);
    assert.ok(!out.includes(SECRET), `${name} must not echo the value`);
  }
  assert.equal(port.saves, 0);
  const other = await call(port, "superagent_configure", { repository: "acme/app", colour: "blue" });
  assert.match(other, /^ERROR: superagent_configure does not take: colour\. It takes: repository, allowed_accounts/);
  assert.equal(port.saves, 0, "nothing is saved when part of the call is refused");
});

test("status says what is missing and whether GitHub sign-in is available, without a token anywhere", async () => {
  const port = new FakePort();
  const status = await statusOf(port);
  assert.equal(status.ready, false);
  assert.equal(status.state, "off");
  assert.equal(status.mode, "observe");
  assert.equal(status.agentAccount, null);
  assert.equal(status.githubSignInAvailable, true);
  assert.ok((status.stillNeeded as string[]).some((gap) => /token/i.test(gap)));
  assert.ok((status.stillNeeded as string[]).some((gap) => /repository/i.test(gap)));
  assert.ok((status.stillNeeded as string[]).some((gap) => /account that may originate|allowed/i.test(gap)));

  port.deviceFlow = false;
  assert.equal((await statusOf(port)).githubSignInAvailable, false);

  const ready = readyPort();
  const done = await statusOf(ready);
  assert.equal(done.ready, true);
  assert.equal(done.agentAccount, "@agent-bot");
  assert.equal(done.repository, "acme/app");
  assert.deepEqual(done.allowedAccounts, ["alice"]);
  assert.deepEqual(done.watching, []);
  assert.ok(!JSON.stringify(done).includes(SECRET));
});

test("configure changes only what it is given, normalises it, and leaves the rest of the settings alone", async () => {
  const port = readyPort();
  const before = port.settings;
  const out = await call(port, "superagent_configure", {
    repository: "https://github.com/Acme/Widgets.git",
    allowed_accounts: ["@Alice", "alice", " bob "],
    watch_issues: true,
    mode: "observe",
  });
  assert.match(out, /^OK: saved\./);
  assert.equal(port.settings.github.repository, "Acme/Widgets");
  assert.deepEqual(port.settings.policy.sources.github?.allowed.map((entry) => entry.id), ["Alice", "bob"], "first spelling wins, @ dropped, spaces trimmed");
  assert.equal(port.settings.github.observeIssues, true);
  assert.equal(port.settings.github.observePulls, false, "what was not mentioned is untouched");
  // Everything configure does not own is exactly as it was.
  assert.deepEqual(port.settings.policy.rules, before.policy.rules);
  assert.deepEqual(port.settings.executor, before.executor);
  assert.deepEqual(port.settings.prompts, before.prompts);
  assert.equal(port.settings.github.pollSeconds, before.github.pollSeconds);
  assert.equal(port.settings.enabled, false, "saving settings never switches it on");
  assert.match(out, /repository → Acme\/Widgets/);
  assert.match(out, /allowed accounts → @Alice, @bob/);
});

test("configure can clear the allowed list and switch watching off again", async () => {
  const port = readyPort();
  await call(port, "superagent_configure", { watch_comments: true });
  assert.equal(port.settings.github.observeComments, true);
  const out = await call(port, "superagent_configure", { allowed_accounts: [], watch_comments: false });
  assert.match(out, /allowed accounts → \(none\)/);
  assert.equal(port.settings.github.observeComments, false);
  assert.deepEqual(port.settings.policy.sources.github?.allowed, []);
  assert.equal((await statusOf(port)).ready, false, "an empty allowed list is a gap again");
});

test("configure refuses nothing-to-change, bad input and the agent's own account, and saves nothing", async () => {
  const port = readyPort();
  const saves = port.saves;

  assert.match(await call(port, "superagent_configure"), /^ERROR: Nothing to change/);
  assert.match(await call(port, "superagent_configure", { mode: "yolo" }), /^ERROR: mode must be one of: off, observe, auto/);
  assert.match(await call(port, "superagent_configure", { watch_issues: "yes" }), /^ERROR: watch_issues must be true or false/);
  assert.match(await call(port, "superagent_configure", { allowed_accounts: ["not a login!"] }), /^ERROR: .*is not a GitHub username/);
  assert.match(await call(port, "superagent_configure", { allowed_accounts: [123] }), /^ERROR: allowed_accounts must be a list/);
  assert.match(await call(port, "superagent_configure", { allowed_accounts: ["@Agent-Bot"] }), /^ERROR: @agent-bot is the agent's own account/);

  // A token pasted where a username or a repository goes is refused by the same checks, and nothing reaches the settings.
  assert.match(await call(port, "superagent_configure", { allowed_accounts: [SECRET] }), /^ERROR: .*is not a GitHub username/);
  assert.match(await call(port, "superagent_configure", { repository: SECRET }), /^ERROR: .*owner\/name/);

  assert.equal(port.saves, saves);
  assert.ok(!JSON.stringify(port.settings).includes(SECRET));
});

test("configure reports a settings change made meanwhile instead of overwriting it", async () => {
  const port = readyPort();
  const original = port.current.bind(port);
  port.current = () => {
    const reply = original();
    port.revision++;
    return reply;
  };
  const out = await call(port, "superagent_configure", { watch_issues: true });
  assert.match(out, /^ERROR: Settings changed since they were read/);
  assert.equal(port.settings.github.observeIssues, false);
});

test("switching on is refused until setup is complete, and says what is left", async () => {
  const port = new FakePort();
  const out = await call(port, "superagent_set_state", { state: "on" });
  assert.match(out, /^ERROR: Superagent cannot run yet\. Still needed:/);
  assert.match(out, /token/i);
  assert.equal(port.settings.enabled, false);
  assert.equal(port.saves, 0);
  assert.match(await call(port, "superagent_set_state", { state: "paused" }), /^ERROR: Superagent cannot run yet/);
  assert.match(await call(port, "superagent_set_state", { state: "maybe" }), /^ERROR: state must be one of: on, paused, off/);
});

test("once ready it switches on, pauses and turns off, saying what each mode will do", async () => {
  const port = readyPort();
  await call(port, "superagent_configure", { watch_issues: true });

  const on = await call(port, "superagent_set_state", { state: "on" });
  assert.match(on, /^OK: Superagent is on\./);
  assert.match(on, /observe: .*directly still gets work done.*would accept/);
  assert.deepEqual([port.settings.enabled, port.settings.paused], [true, false]);
  assert.equal((await statusOf(port)).state, "on");

  assert.match(await call(port, "superagent_set_state", { state: "paused" }), /^OK: Superagent is paused\./);
  assert.deepEqual([port.settings.enabled, port.settings.paused], [true, true]);
  assert.equal((await statusOf(port)).state, "paused");

  assert.match(await call(port, "superagent_set_state", { state: "off" }), /^OK: Superagent is off\./);
  assert.deepEqual([port.settings.enabled, port.settings.paused], [false, false]);

  await call(port, "superagent_configure", { mode: "auto" });
  assert.match(await call(port, "superagent_set_state", { state: "on" }), /auto: it acts on direct mentions and on other requests/);
});

test("turning off always works, even when setup was never finished", async () => {
  const port = new FakePort();
  assert.match(await call(port, "superagent_set_state", { state: "off" }), /^OK: Superagent is off\./);
});

test("switching on warns when nothing is being watched", async () => {
  const port = readyPort();
  assert.match(await call(port, "superagent_set_state", { state: "on" }), /Nothing is being watched yet/);
});

test("connecting starts with a code and a link, tells the person to use the agent account, and asks for no token", async () => {
  const port = new FakePort();
  const out = await call(port, "superagent_connect_github", { action: "start" });
  assert.match(out, /WDJB-MJHT/);
  assert.match(out, /https:\/\/github\.com\/login\/device/);
  assert.match(out, /AGENT account/);
  assert.match(out, /private window/);
  assert.match(out, /two options/, "ask_question drops a question with one option, so the guidance must say two");
  assert.doesNotMatch(out, /paste (it|your token) here/i);
});

test("finishing says pending until the person approved, then names the account and asks to confirm it is the agent's", async () => {
  const port = new FakePort();
  await call(port, "superagent_connect_github", { action: "start" });
  assert.match(await call(port, "superagent_connect_github", { action: "finish" }), /^PENDING:/);
  assert.equal(port.login, null);

  port.approved = true;
  const out = await call(port, "superagent_connect_github", { action: "finish" });
  assert.match(out, /^OK: connected as @agent-bot\./);
  assert.match(out, /dedicated agent account and not their own/);
  assert.ok(!out.includes(SECRET));
  assert.equal((await statusOf(port)).agentAccount, "@agent-bot");
});

test("connecting warns when the account that signed in is on the allowed list", async () => {
  const port = readyPort();
  port.login = null;
  port.settings = parseSettings({ ...port.settings, policy: { ...port.settings.policy, sources: { github: { allowed: [{ id: "agent-bot" }], bots: [], admission: {} } } } });
  port.approved = true;
  await call(port, "superagent_connect_github", { action: "start" });
  const out = await call(port, "superagent_connect_github", { action: "finish" });
  assert.match(out, /@agent-bot is on the allowed list, which is not permitted/);
});

test("when GitHub sign-in is not available the tool says where the person pastes a token, never in chat", async () => {
  const port = new FakePort();
  port.deviceFlow = false;
  const out = await call(port, "superagent_connect_github", { action: "start" });
  assert.match(out, /^UNAVAILABLE:/);
  assert.match(out, /More → Superagent → Set up tab → Agent account → GitHub token/);
  assert.match(out, /Never ask them to paste it in chat/);
  assert.match(out, /Contents, Issues, Pull requests = read and write/);
});

test("an account that is already connected is not replaced silently", async () => {
  const port = readyPort();
  const out = await call(port, "superagent_connect_github", { action: "start" });
  assert.match(out, /^Already connected as @agent-bot\./);
  assert.match(out, /superagent_disconnect/);
});

test("connect only accepts start or finish", async () => {
  const port = new FakePort();
  assert.match(await call(port, "superagent_connect_github", { action: "token" }), /^ERROR: action must be one of: start, finish/);
  assert.match(await call(port, "superagent_connect_github", {}), /^ERROR: action must be one of/);
});

test("verify says who can push, and says plainly when the account cannot", async () => {
  const port = readyPort();
  assert.equal(await call(port, "superagent_verify"), "OK: @agent-bot can push to acme/app.");
  port.canPush = false;
  assert.match(await call(port, "superagent_verify"), /^WARNING: @agent-bot can see acme\/app but cannot push to it.*write access/);
  port.login = null;
  assert.equal(await call(port, "superagent_verify"), "ERROR: No GitHub token is stored");
});

test("disconnect deletes the token and the account is gone from the status", async () => {
  const port = readyPort();
  assert.match(await call(port, "superagent_disconnect"), /^OK: the GitHub token was deleted\./);
  assert.equal(port.cleared, 1);
  assert.equal((await statusOf(port)).agentAccount, null);
});

test("a port that fails is reported as an error the model can read, not thrown into the agent loop", async () => {
  const port = readyPort();
  port.current = () => {
    throw new Error("store is locked");
  };
  assert.equal(await call(port, "superagent_status"), "ERROR: store is locked");
  assert.equal(await call(port, "superagent_configure", { watch_issues: true }), "ERROR: store is locked");
});

test("nothing any tool says, across a whole setup, contains the token", async () => {
  const port = new FakePort();
  port.approved = true;
  const said: string[] = [];
  for (const [name, args] of [
    ["superagent_status", {}],
    ["superagent_configure", { repository: "acme/app", allowed_accounts: ["alice"], watch_issues: true }],
    ["superagent_connect_github", { action: "start" }],
    ["superagent_connect_github", { action: "finish" }],
    ["superagent_verify", {}],
    ["superagent_set_state", { state: "on" }],
    ["superagent_status", {}],
    ["superagent_disconnect", {}],
  ] as const) {
    said.push(await call(port, name, args));
  }
  assert.ok(said.some((line) => line.includes("OK: Superagent is on")), "the setup really ran to the end");
  for (const line of said) assert.ok(!line.includes(SECRET), line);
});

test("the setup skill and the /superagent command name exactly the tools that exist", () => {
  const registered = createSuperagentChatTools(new FakePort()).map((tool) => tool.name).sort();
  const skill = BUILTIN_SKILLS.find((candidate) => candidate.name === "setup-superagent");
  assert.ok(skill, "setup-superagent ships built in");
  // A tool the skill never mentions would never be used; one it mentions that does not exist would fail mid-interview.
  assert.deepEqual([...new Set(skill.content.match(/superagent_[a-z_]+/g))].sort(), registered);

  const command = BUILTIN_COMMANDS.find((candidate) => candidate.name === "superagent");
  assert.ok(command, "/superagent ships built in");
  for (const name of command.body.match(/superagent_[a-z_]+/g) ?? []) assert.ok(registered.includes(name), `${name} is not a tool`);
});
