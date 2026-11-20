import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolContext, ToolDefinition } from "@deyin/agent-core";
import type { OnePasswordField, OnePasswordLogin } from "@deyin/host-core/shared";
import { OnePasswordError, type OnePasswordPort } from "../src/main/bots/onepassword.js";
import { createOnePasswordTools } from "../src/main/bots/onepassword-tools.js";
import type { VaultAnswer, VaultApproval, VaultPage, VaultPageSource } from "../src/main/bots/vault-tools.js";

const CTX = { cwd: "/tmp", todos: [] } as ToolContext;
const GITHUB = "abcdefghijklmnopqrstuvwxyz";
const AWS = "zyxwvutsrqponmlkjihgfedcba";
const PASSWORD = "p4ssw0rd-from-1password";

const LOGINS: OnePasswordLogin[] = [
  { id: GITHUB, title: "GitHub", username: "octocat", sites: ["github.com"] },
  { id: AWS, title: "AWS", username: "root@example.com", sites: ["aws.amazon.com", "signin.aws.amazon.com"] },
];

class FakePage implements VaultPage {
  fills: Array<{ ref: string; value: string }> = [];
  submits = 0;
  reads = 0;
  moveAfter: { reads: number; to: string } | null = null;
  failOn: string | null = null;
  constructor(public address: string) {}
  async url(): Promise<string> {
    this.reads += 1;
    if (this.moveAfter && this.reads > this.moveAfter.reads) this.address = this.moveAfter.to;
    return this.address;
  }
  async fill(ref: string, value: string): Promise<void> {
    if (this.failOn === ref) throw new Error(`Ref ${ref} is a button; could not type ${PASSWORD}`);
    this.fills.push({ ref, value });
  }
  async submit(): Promise<void> {
    this.submits += 1;
  }
}

interface Setup {
  address?: string;
  answers?: VaultAnswer[];
  attended?: boolean;
  logins?: OnePasswordLogin[];
  credential?: Partial<Record<OnePasswordField, string | null>>;
  listError?: Error;
  credentialError?: Error;
}

function setup(options: Setup = {}) {
  const page = new FakePage(options.address ?? "https://github.com/login");
  const asked: VaultApproval[] = [];
  const answers = [...(options.answers ?? ["allow"])];
  const hidden: string[] = [];
  const calls = { logins: 0, credential: [] as string[] };
  const onePassword: OnePasswordPort = {
    logins: async () => {
      calls.logins += 1;
      if (options.listError) throw options.listError;
      return options.logins ?? LOGINS;
    },
    credential: async (id) => {
      calls.credential.push(id);
      if (options.credentialError) throw options.credentialError;
      return { username: "octocat", password: PASSWORD, ...(options.credential ?? {}) };
    },
  };
  const source: VaultPageSource = { withPage: (_ctx, fn) => fn(page) };
  const tools = createOnePasswordTools({
    onePassword,
    botId: "bot-1",
    pages: { browser: source },
    ...((options.attended ?? true)
      ? {
          ask: async (request: VaultApproval) => {
            asked.push(request);
            return answers.shift() ?? "deny";
          },
        }
      : {}),
    hide: (value) => void hidden.push(value),
  });
  const tool = (name: string): ToolDefinition => {
    const found = tools.find((candidate) => candidate.name === name);
    assert.ok(found, name);
    return found;
  };
  const run = (name: string, args: Record<string, unknown>) => tool(name).execute(args, CTX) as Promise<string>;
  return { page, asked, hidden, calls, tools, run };
}

const fillArgs = (over: Record<string, unknown> = {}) => ({
  entry: GITHUB,
  fields: [
    { ref: "e1", field: "username" },
    { ref: "e2", field: "password" },
  ],
  ...over,
});

test("two tools: one to list and one to fill, named for 1Password", () => {
  const { tools } = setup();
  assert.deepEqual(tools.map((tool) => [tool.name, tool.tier]), [["onepassword_list", "read"], ["onepassword_fill", "execute"]]);
});

test("the list shows the id, the user name and the sites, and no password", async () => {
  const { run } = setup();
  const text = await run("onepassword_list", {});
  assert.match(text, new RegExp(`id ${GITHUB} — "GitHub" · user octocat · sites github.com`));
  assert.match(text, /sites aws.amazon.com, signin.aws.amazon.com/);
  assert.ok(!text.includes(PASSWORD));
});

test("a site narrows the list to the logins saved for it, subdomains included, look-alikes not", async () => {
  const lookalike: OnePasswordLogin = { id: "lookalikeid1234567890", title: "Fake", username: "", sites: ["github.com.evil.example"] };
  const { run } = setup({ logins: [...LOGINS, lookalike] });
  const text = await run("onepassword_list", { site: "https://gist.github.com/me" });
  assert.match(text, /GitHub/);
  assert.ok(!/AWS/.test(text) && !/Fake/.test(text), text);
  assert.match(await run("onepassword_list", { site: "nothing.example" }), /no login saved for that site.*secure_form_fill/s);
  assert.match(await run("onepassword_list", { site: "not a site!" }), /^ERROR: site must be/);
});

test("a long list is cut at fifty, and says how many more there are", async () => {
  const many = Array.from({ length: 60 }, (_, index): OnePasswordLogin => ({ id: `login${String(index).padStart(10, "0")}`, title: `Login ${index}`, username: "", sites: ["example.com"] }));
  const { run } = setup({ logins: many });
  const lines = (await run("onepassword_list", {})).split("\n");
  assert.equal(lines.filter((line) => line.startsWith("- id ")).length, 50);
  assert.ok(lines.some((line) => line.startsWith("…and 10 more.")));
});

test("exactly fifty logins are all shown, with nothing said about more", async () => {
  const fifty = Array.from({ length: 50 }, (_, index): OnePasswordLogin => ({ id: `login${String(index).padStart(10, "0")}`, title: `Login ${index}`, username: "", sites: ["example.com"] }));
  const text = await setup({ logins: fifty }).run("onepassword_list", {});
  assert.equal(text.split("\n").filter((line) => line.startsWith("- id ")).length, 50);
  assert.ok(!text.includes("more."));
});

test("an empty 1Password says so and points at the fallback", async () => {
  const { run } = setup({ logins: [] });
  assert.match(await run("onepassword_list", {}), /no logins.*secure_form_fill/s);
});

test("when 1Password cannot be reached, the model gets its refusal as text, not an exception", async () => {
  const { run } = setup({ listError: new OnePasswordError("1Password is locked or not signed in.") });
  assert.equal(await run("onepassword_list", {}), "ERROR: 1Password is locked or not signed in.");
});

test("filling asks the person once for this use, reads the password then, and types it in", async () => {
  const { run, page, asked, hidden, calls } = setup();
  const result = await run("onepassword_fill", fillArgs({ submit: true }));
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.once, true, "nothing is kept, so the card must not offer to keep it");
  assert.equal(asked[0]?.summary, 'Use "GitHub" from 1Password on github.com');
  assert.deepEqual(page.fills, [{ ref: "e1", value: "octocat" }, { ref: "e2", value: PASSWORD }]);
  assert.equal(page.submits, 1);
  assert.deepEqual(calls.credential, [GITHUB]);
  assert.deepEqual(hidden, [PASSWORD], "the password is hidden from everything the Bot reads, and only the password");
  assert.match(result, /Filled username, password from "GitHub" in 1Password on github.com and pressed Enter/);
  assert.ok(!result.includes(PASSWORD) && !asked[0]?.reason.includes(PASSWORD), "the password never appears in what the model or the card is told");
});

test("every use asks again: 'allow always' is a single yes", async () => {
  const { run, asked } = setup({ answers: ["allow-always", "allow"] });
  await run("onepassword_fill", fillArgs());
  await run("onepassword_fill", fillArgs());
  assert.equal(asked.length, 2);
});

test("a person who says no stops it before the password is read or anything is typed", async () => {
  const { run, page, calls, hidden } = setup({ answers: ["deny"] });
  assert.match(await run("onepassword_fill", fillArgs()), /^ERROR: The person did not allow using "GitHub" on github.com\. Do not try again/);
  assert.deepEqual(page.fills, []);
  assert.deepEqual(calls.credential, []);
  assert.deepEqual(hidden, []);
});

test("with nobody there (a routine) it never fills, and never reads the password", async () => {
  const { run, page, calls } = setup({ attended: false });
  assert.match(await run("onepassword_fill", fillArgs()), /^ERROR: .*needs a person's agreement, and nobody is here/);
  assert.deepEqual(page.fills, []);
  assert.deepEqual(calls.credential, []);
});

test("a page that is not one of the login's sites is refused without asking anyone", async () => {
  for (const address of ["https://github.com.evil.example/login", "https://evil-github.com/", "https://example.org/"]) {
    const { run, page, asked, calls } = setup({ address });
    assert.match(await run("onepassword_fill", fillArgs()), /^ERROR: "GitHub" is not saved for .* in 1Password, so it was not filled/, address);
    assert.deepEqual(asked, [], address);
    assert.deepEqual(page.fills, [], address);
    assert.deepEqual(calls.credential, [], address);
  }
});

test("a page on a subdomain of a saved site is fine", async () => {
  const { run, page } = setup({ address: "https://login.github.com/session" });
  await run("onepassword_fill", fillArgs());
  assert.equal(page.fills.length, 2);
});

test("only https pages (or this computer) are filled", async () => {
  const { run, page, asked } = setup({ address: "http://github.com/login" });
  assert.match(await run("onepassword_fill", fillArgs()), /^ERROR: .*is not somewhere a saved credential can be filled in/);
  assert.deepEqual(asked, []);
  assert.deepEqual(page.fills, []);
});

test("an id that 1Password does not list is refused, and an id that could be an option is never even looked up", async () => {
  const unknown = setup();
  assert.match(await unknown.run("onepassword_fill", fillArgs({ entry: "nosuchid12345678" })), /^ERROR: 1Password has no login with that id/);
  const flag = setup();
  assert.match(await flag.run("onepassword_fill", fillArgs({ entry: "--vault=x" })), /^ERROR: 1Password has no login with that id/);
  assert.equal(flag.calls.logins, 0, "an id like that is turned away before 1Password is asked anything");
});

test("the fields are checked before anything is asked: refs from a snapshot, and only username or password", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [fillArgs({ fields: [] }), /at least one/],
    [fillArgs({ fields: "x" }), /at least one/],
    [fillArgs({ fields: [{ ref: "#pw", field: "password" }] }), /ref from browser_snapshot/],
    [fillArgs({ fields: [null] }), /ref from browser_snapshot/],
    [fillArgs({ fields: ["e1"] }), /ref from browser_snapshot/],
    [fillArgs({ fields: [{ ref: "e1", field: "totp" }] }), /not something 1Password can fill here/],
    [fillArgs({ fields: [{ ref: "e1", field: "username" }, { ref: "e2", field: "password" }, { ref: "e3", field: "password" }] }), /at most 2/],
  ];
  for (const [args, message] of cases) {
    const { run, asked, calls } = setup();
    assert.match(await run("onepassword_fill", args), message);
    assert.deepEqual(asked, []);
    assert.equal(calls.logins, 0);
  }
});

test("a login with no password in 1Password is reported, and nothing is half-filled", async () => {
  const { run, page, hidden } = setup({ credential: { password: null } });
  assert.match(await run("onepassword_fill", fillArgs()), /^ERROR: "GitHub" has no password in 1Password\./);
  assert.deepEqual(page.fills, []);
  assert.deepEqual(hidden, []);
});

test("if the page moves while the person decides, nothing is typed", async () => {
  const { run, page } = setup();
  page.moveAfter = { reads: 1, to: "https://evil.example/phish" };
  assert.match(await run("onepassword_fill", fillArgs()), /^ERROR: The page changed while waiting, so nothing was filled/);
  assert.deepEqual(page.fills, []);
});

test("a field the page refuses is reported with what was filled before it", async () => {
  const { run, page } = setup();
  page.failOn = "e2";
  // The page's own message is passed on, because it is how the model learns the ref was wrong. If it carried the password,
  // the run's redaction (tested with the run) is what removes it, as for the Vault's own tool.
  assert.match(await run("onepassword_fill", fillArgs()), /^ERROR: Filled username, but could not fill password into e2: Ref e2 is a button/);
});

test("1Password refusing at the last step is reported, with nothing typed", async () => {
  const { run, page } = setup({ credentialError: new OnePasswordError("1Password did not answer in time. It may be waiting for you to unlock it or approve this.") });
  assert.match(await run("onepassword_fill", fillArgs()), /^ERROR: 1Password did not answer in time/);
  assert.deepEqual(page.fills, []);
});

test("the second site of a login works, and the first login is not used for the other", async () => {
  const { run, page } = setup({ address: "https://signin.aws.amazon.com/oauth" });
  await run("onepassword_fill", fillArgs({ entry: AWS }));
  assert.equal(page.fills.length, 2);
  const wrong = setup({ address: "https://signin.aws.amazon.com/oauth" });
  assert.match(await wrong.run("onepassword_fill", fillArgs({ entry: GITHUB })), /not saved for signin.aws.amazon.com/);
});
