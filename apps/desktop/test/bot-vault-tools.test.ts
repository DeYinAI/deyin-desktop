import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ToolContext, ToolDefinition } from "@deyin/agent-core";
import { FileStorage, VaultStore, type SecretCipher, type SecureFormRequest } from "@deyin/host-core";
import {
  createVaultTools,
  type VaultAnswer,
  type VaultApproval,
  type VaultPage,
  type VaultPageSource,
  type VaultSurface,
} from "../src/main/bots/vault-tools.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const rot: SecretCipher = {
  encrypt: (plain) => `enc:${Buffer.from(plain).toString("base64")}`,
  decrypt: (stored) => (stored.startsWith("enc:") ? Buffer.from(stored.slice(4), "base64").toString() : null),
};

const PASSWORD = "hunter2hunter2";
const VISA = "4242424242424242";
const BOT = "ada-bot";
const CTX = { cwd: "/tmp", todos: [] } as ToolContext;

/** A page that records what is typed into it. `url` can be changed between calls to simulate navigation. */
class FakePage implements VaultPage {
  fills: Array<{ ref: string; value: string }> = [];
  submits = 0;
  failOn: string | null = null;
  urlCalls = 0;
  /** What the page address becomes after this many reads, to simulate the page moving. */
  moveAfter: { reads: number; to: string } | null = null;
  constructor(public address: string) {}
  async url(): Promise<string> {
    this.urlCalls += 1;
    if (this.moveAfter && this.urlCalls > this.moveAfter.reads) this.address = this.moveAfter.to;
    return this.address;
  }
  async fill(ref: string, value: string): Promise<void> {
    if (this.failOn === ref) throw new Error(`Ref ${ref} is a button; use click instead of fill.`);
    this.fills.push({ ref, value });
  }
  async submit(): Promise<void> {
    this.submits += 1;
  }
}

const source = (page: FakePage): VaultPageSource => ({ withPage: (_ctx, fn) => fn(page) });

interface Setup {
  asks?: VaultAnswer[];
  attended?: boolean;
  address?: string;
  takeover?: Array<"done" | "declined">;
  form?: Array<Record<string, string> | null>;
  surfaces?: VaultSurface[];
}

function setup(options: Setup = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deyin-vtools-"));
  dirs.push(dir);
  const storage = new FileStorage(dir, rot);
  storages.push(storage);
  let n = 0;
  const vault = new VaultStore(storage, { newId: () => `id${(n += 1)}` });
  const page = new FakePage(options.address ?? "https://github.com/login");
  const other = new FakePage("https://example.org/");
  const asked: VaultApproval[] = [];
  const answers = [...(options.asks ?? [])];
  const takeovers: string[] = [];
  const takeoverAnswers = [...(options.takeover ?? [])];
  const forms: SecureFormRequest[] = [];
  const formAnswers = [...(options.form ?? [])];
  const hidden: string[] = [];
  const surfaces = options.surfaces ?? ["browser"];
  const attended = options.attended ?? true;
  const tools = createVaultTools({
    vault,
    botId: BOT,
    pages: Object.fromEntries(surfaces.map((s) => [s, source(s === "browser" ? page : other)])),
    ...(attended
      ? {
          ask: async (request: VaultApproval): Promise<VaultAnswer> => {
            asked.push(request);
            return answers.shift() ?? "deny";
          },
          takeover: async (reason: string) => {
            takeovers.push(reason);
            return takeoverAnswers.shift() ?? "declined";
          },
          secureForm: async (request: SecureFormRequest) => {
            forms.push(request);
            return formAnswers.shift() ?? null;
          },
        }
      : {}),
    hide: (value) => hidden.push(value),
  });
  const tool = (name: string): ToolDefinition => {
    const found = tools.find((candidate) => candidate.name === name);
    assert.ok(found, name);
    return found;
  };
  const run = (name: string, args: Record<string, unknown>): Promise<string> => tool(name).execute(args, CTX);
  const login = (over: Record<string, unknown> = {}) =>
    vault.put({ kind: "login", title: "GitHub", username: "ada", password: PASSWORD, sites: ["github.com"], ...over });
  return { vault, page, other, asked, takeovers, forms, hidden, tools, tool, run, login };
}

const login = (over: Record<string, unknown> = {}) => ({ kind: "login", title: "GitHub", username: "ada", password: PASSWORD, sites: ["github.com"], notes: "recovery code 99887766", ...over });
const card = (over: Record<string, unknown> = {}) => ({ kind: "card", title: "Visa", number: VISA, securityCode: "123", expMonth: 4, expYear: new Date().getFullYear() + 3, holderName: "Ada", ...over });

const fillBoth = (entry: string, extra: Record<string, unknown> = {}) => ({
  entry,
  fields: [
    { ref: "e1", field: "username" },
    { ref: "e2", field: "password" },
  ],
  ...extra,
});

/* The tools ---------------------------------------------------------------- */

test("the tools are named for what they do, and the tiers match the risk", () => {
  const h = setup();
  assert.deepEqual(h.tools.map((t) => [t.name, t.tier]), [
    ["vault_list", "read"],
    ["vault_fill", "execute"],
    ["request_takeover", "interaction"],
    ["secure_form_fill", "interaction"],
  ]);
});

test("the browser is only a choice when there are two", () => {
  const one = setup().tool("vault_fill").parameters as unknown as { properties: Record<string, unknown> };
  assert.equal("surface" in one.properties, false);
  const two = setup({ surfaces: ["browser", "chrome"] });
  for (const name of ["vault_fill", "secure_form_fill"]) {
    const params = two.tool(name).parameters as unknown as { properties: { surface?: { enum: string[] } } };
    assert.deepEqual(params.properties.surface?.enum, ["browser", "chrome"], name);
  }
});

/* vault_list --------------------------------------------------------------- */

test("an empty Vault says so and points to a person", async () => {
  const h = setup();
  const out = await h.run("vault_list", {});
  assert.match(out, /The Vault is empty\./);
  assert.match(out, /request_takeover or secure_form_fill/);
});

test("the list has ids, usernames, card endings and fillable fields, and nothing secret", async () => {
  const h = setup();
  const l = h.vault.put(login());
  const c = h.vault.put(card());
  const k = h.vault.put({ kind: "contact", title: "Home", email: "ada@example.com", address: { line1: "1 Main St" }, defaultShipping: true });
  const out = await h.run("vault_list", {});
  assert.match(out, new RegExp(`- id ${l.id} — login · "GitHub" · user ada · sites github\\.com — fields: username, password`));
  assert.match(out, new RegExp(`- id ${c.id} — card · "Visa" · visa ending 4242 · expires 04/\\d\\d · Ada — fields: number, securityCode`));
  assert.match(out, new RegExp(`- id ${k.id} — contact · "Home" · default shipping — fields: name, email, phone`));
  for (const secret of [PASSWORD, VISA, "123", "99887766", "ada@example.com", "1 Main St"]) assert.equal(out.includes(secret.length === 3 ? `"${secret}"` : secret), false, secret);
  assert.equal(out.includes("recovery code"), false, "notes are private");
});

test("the list can be narrowed by kind, and by site for logins only", async () => {
  const h = setup();
  h.vault.put(login());
  h.vault.put(login({ title: "Example", sites: ["example.com"] }));
  h.vault.put(card());
  const logins = await h.run("vault_list", { kind: "login" });
  assert.equal([...logins.matchAll(/^- id /gm)].length, 2);
  const onSite = await h.run("vault_list", { site: "https://login.github.com/session" });
  assert.match(onSite, /GitHub/);
  assert.doesNotMatch(onSite, /Example/);
  assert.match(onSite, /card · "Visa"/, "a card has no site, so it is still offered");
  assert.match(await h.run("vault_list", { kind: "login", site: "github.com" }), /GitHub/);
  assert.match(await h.run("vault_list", { kind: "contact" }), /Nothing in the Vault matches/);
  assert.match(await h.run("vault_list", { site: "unknown.example" }), /card · "Visa"/);
});

test("a bad kind or site is an error, not a guess", async () => {
  const h = setup();
  h.vault.put(login());
  assert.match(await h.run("vault_list", { kind: "note" }), /^ERROR: kind must be login, card or contact/);
  assert.match(await h.run("vault_list", { site: "not a host!!" }), /^ERROR: site must be a web address or a host name/);
});

test("a long list is cut off and says how to narrow it", async () => {
  const h = setup();
  for (let i = 0; i < 105; i += 1) h.vault.put({ kind: "contact", title: `c${String(i).padStart(3, "0")}`, email: "a@b.co" });
  const out = await h.run("vault_list", {});
  assert.equal([...out.matchAll(/^- id /gm)].length, 100);
  assert.match(out, /…and 5 more\. Pass kind or site to narrow it\./);
});

/* vault_fill: what is checked before anything is typed ---------------------- */

test("an unknown id, no fields, a bad ref or a field the item lacks all fail without touching the page", async () => {
  const h = setup();
  const saved = h.login();
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ fields: [{ ref: "e1", field: "username" }] }, /No Vault item has that id/],
    [{ entry: "ghost", fields: [{ ref: "e1", field: "username" }] }, /No Vault item has that id/],
    [{ entry: saved.id }, /at least one/],
    [{ entry: saved.id, fields: [] }, /at least one/],
    [{ entry: saved.id, fields: [{ ref: "12", field: "username" }] }, /ref from browser_snapshot is needed/],
    [{ entry: saved.id, fields: [{ ref: "e1", field: "number" }] }, /not a field of this login\. Its fields are: username, password/],
    [{ entry: saved.id, fields: [{ ref: "e1" }] }, /not a field of this login/],
    [{ entry: saved.id, fields: ["e1"] }, /ref from browser_snapshot is needed/],
    [{ entry: saved.id, fields: Array.from({ length: 13 }, (_, i) => ({ ref: `e${i}`, field: "username" })) }, /at most 12/],
  ];
  for (const [args, pattern] of cases) {
    assert.match(await h.run("vault_fill", args), pattern);
  }
  assert.deepEqual(h.page.fills, []);
  assert.equal(h.page.urlCalls, 0, "the page was not even read");
  assert.deepEqual(h.asked, []);
});

test("a field the item has no value for is reported before the page is touched", async () => {
  const h = setup();
  const c = h.vault.put(card({ securityCode: undefined }));
  const out = await h.run("vault_fill", { entry: c.id, fields: [{ ref: "e1", field: "number" }, { ref: "e2", field: "securityCode" }] });
  assert.match(out, /^ERROR: "Visa" has no securityCode saved\./);
  assert.deepEqual(h.page.fills, []);
  assert.equal(h.page.urlCalls, 0);
});

test("a page that is not https is refused, and nobody is asked", async () => {
  for (const address of ["http://github.com/login", "about:blank", "file:///etc/passwd", "https://user:pw@github.com/"]) {
    const h = setup({ address });
    const saved = h.login();
    const out = await h.run("vault_fill", fillBoth(saved.id));
    assert.match(out, /^ERROR: .* is not somewhere a saved credential can be filled in/, address);
    assert.deepEqual(h.asked, []);
    assert.deepEqual(h.page.fills, []);
  }
});

test("with no browser, there is nothing to fill into", async () => {
  const h = setup({ surfaces: [] });
  const saved = h.login();
  assert.match(await h.run("vault_fill", fillBoth(saved.id)), /^ERROR: No browser is available to fill/);
  assert.match(await h.run("secure_form_fill", { title: "x", fields: [{ id: "a", label: "A", ref: "e1" }] }), /^ERROR: No browser is available to fill/);
});

test("an unknown browser is named with the ones there are", async () => {
  const h = setup({ surfaces: ["browser", "chrome"] });
  const saved = h.login();
  assert.match(await h.run("vault_fill", fillBoth(saved.id, { surface: "firefox" })), /^ERROR: surface must be one of: browser, chrome\./);
  assert.deepEqual(h.page.fills, []);
});

test("the second browser is used when asked for", async () => {
  const h = setup({ surfaces: ["browser", "chrome"], asks: ["allow"] });
  const saved = h.login({ sites: ["example.org"] });
  const out = await h.run("vault_fill", fillBoth(saved.id, { surface: "chrome" }));
  assert.match(out, /^Filled username, password from "GitHub" on example\.org/);
  assert.equal(h.other.fills.length, 2);
  assert.equal(h.page.fills.length, 0);
});

/* vault_fill: agreeing ----------------------------------------------------- */

test("the first use on a site asks, shows where, and fills once on yes", async () => {
  const h = setup({ asks: ["allow"] });
  const saved = h.login();
  const out = await h.run("vault_fill", fillBoth(saved.id));
  assert.deepEqual(h.asked.map((a) => a.summary), ['Use "GitHub" on github.com']);
  assert.match(h.asked[0]?.reason ?? "", /It never sees the password/);
  assert.match(h.asked[0]?.reason ?? "", /"Always allow" keeps this for this Bot on github\.com\./);
  assert.deepEqual(h.page.fills, [{ ref: "e1", value: "ada" }, { ref: "e2", value: PASSWORD }]);
  assert.match(out, /^Filled username, password from "GitHub" on github\.com\. The values are not shown to you\./);
  assert.equal(out.includes(PASSWORD), false);
  assert.equal(h.vault.hasGrant(BOT, saved.id, "github.com"), false, "a one-time yes is not kept");
});

test("asking again after a one-time yes, and never after always", async () => {
  const h = setup({ asks: ["allow", "allow-always"] });
  const saved = h.login();
  await h.run("vault_fill", fillBoth(saved.id));
  await h.run("vault_fill", fillBoth(saved.id));
  assert.equal(h.asked.length, 2);
  assert.equal(h.vault.hasGrant(BOT, saved.id, "github.com"), true);
  await h.run("vault_fill", fillBoth(saved.id));
  await h.run("vault_fill", fillBoth(saved.id));
  assert.equal(h.asked.length, 2, "kept once the person said always");
  assert.equal(h.page.fills.length, 8);
});

test("no is respected: nothing is typed, and the Bot is told not to push", async () => {
  const h = setup({ asks: ["deny"] });
  const saved = h.login();
  const out = await h.run("vault_fill", fillBoth(saved.id));
  assert.match(out, /^ERROR: The person did not allow using "GitHub" on github\.com\. Do not try again/);
  assert.deepEqual(h.page.fills, []);
  assert.equal(h.vault.hasGrant(BOT, saved.id, "github.com"), false);
});

test("a subdomain of a saved site belongs to it", async () => {
  const h = setup({ asks: ["allow"], address: "https://login.github.com/session" });
  const saved = h.login();
  const out = await h.run("vault_fill", fillBoth(saved.id));
  assert.match(out, /on login\.github\.com/);
  assert.match(h.asked[0]?.reason ?? "", /^The Bot wants to fill/, "it is a saved site, so not the off-site warning");
});

test("another Bot's agreement is not this Bot's", async () => {
  const h = setup({ asks: ["allow"] });
  const saved = h.login();
  h.vault.grant("other-bot", saved.id, "github.com");
  await h.run("vault_fill", fillBoth(saved.id));
  assert.equal(h.asked.length, 1);
});

test("with nobody there, only what was already agreed is filled", async () => {
  const h = setup({ attended: false });
  const saved = h.login();
  const refused = await h.run("vault_fill", fillBoth(saved.id));
  assert.match(refused, /^ERROR: Using "GitHub" on github\.com needs a person's agreement, and nobody is here/);
  assert.deepEqual(h.page.fills, []);
  h.vault.grant(BOT, saved.id, "github.com");
  assert.match(await h.run("vault_fill", fillBoth(saved.id)), /^Filled username, password/);
  assert.equal(h.page.fills.length, 2);
});

/* vault_fill: a page that is not one of the login's sites ------------------- */

test("a page that is not a saved site is only filled when a person says so, with a warning", async () => {
  const h = setup({ address: "https://github.com.evil.example/login", asks: ["allow"] });
  const saved = h.login();
  const out = await h.run("vault_fill", fillBoth(saved.id));
  assert.match(h.asked[0]?.reason ?? "", /is saved for github\.com, not github\.com\.evil\.example\. Only agree if you trust/);
  assert.match(h.asked[0]?.reason ?? "", /"Always allow" also saves github\.com\.evil\.example for this login and keeps the agreement for this Bot\./);
  assert.match(out, /^Filled/);
  assert.deepEqual(h.vault.get(saved.id) && (h.vault.get(saved.id) as { sites: string[] }).sites, ["github.com"], "a one-time yes does not add the site");
  assert.equal(h.vault.hasGrant(BOT, saved.id, "github.com.evil.example"), false);
});

test("always on a page that is not saved adds the site and keeps the agreement", async () => {
  const h = setup({ address: "https://accounts.example.net/login", asks: ["allow-always"] });
  const saved = h.login();
  await h.run("vault_fill", fillBoth(saved.id));
  assert.deepEqual((h.vault.get(saved.id) as { sites: string[] }).sites, ["github.com", "accounts.example.net"]);
  assert.equal(h.vault.hasGrant(BOT, saved.id, "accounts.example.net"), true);
  await h.run("vault_fill", fillBoth(saved.id));
  assert.equal(h.asked.length, 1, "now it is a saved site, so no more asking");
});

test("an agreement for a host the login no longer lists does not skip the question", async () => {
  const h = setup({ address: "https://old.example.net/login", asks: ["deny"] });
  const saved = h.login();
  h.vault.grant(BOT, saved.id, "old.example.net");
  const out = await h.run("vault_fill", fillBoth(saved.id));
  assert.equal(h.asked.length, 1);
  assert.match(out, /did not allow/);
  assert.deepEqual(h.page.fills, []);
});

test("a page that is not a saved site is refused outright when nobody is there", async () => {
  const h = setup({ address: "https://evil.example/login", attended: false });
  const saved = h.login();
  h.vault.grant(BOT, saved.id, "evil.example");
  assert.match(await h.run("vault_fill", fillBoth(saved.id)), /^ERROR: "GitHub" is not saved for evil\.example, so it was not filled\. Nobody is here to agree to it\./);
  assert.deepEqual(h.page.fills, []);
});

test("a login whose site cannot be added is not filled on always", async () => {
  const h = setup({ address: "https://s20.example.net/", asks: ["allow-always"] });
  const sites = Array.from({ length: 20 }, (_, i) => `s${i}.example.com`);
  const saved = h.login({ sites });
  const out = await h.run("vault_fill", fillBoth(saved.id));
  assert.match(out, /^ERROR: "GitHub" could not be saved for s20\.example\.net, so it was not filled\./);
  assert.deepEqual(h.page.fills, []);
  assert.equal(h.vault.hasGrant(BOT, saved.id, "s20.example.net"), false);
});

/* vault_fill: cards and contacts have no site, but are still asked about ----- */

test("a card is asked about on each new site, and its number goes in without being shown", async () => {
  const h = setup({ address: "https://shop.example.com/checkout", asks: ["allow-always"] });
  const c = h.vault.put(card());
  const out = await h.run("vault_fill", { entry: c.id, fields: [{ ref: "e5", field: "number" }, { ref: "e6", field: "securityCode" }, { ref: "e7", field: "expiry" }] });
  assert.match(h.asked[0]?.reason ?? "", /never sees the card number/);
  assert.deepEqual(h.page.fills.map((f) => f.ref), ["e5", "e6", "e7"]);
  assert.equal(h.page.fills[0]?.value, VISA);
  assert.equal(h.page.fills[1]?.value, "123");
  assert.match(h.page.fills[2]?.value ?? "", /^04\/\d\d$/);
  for (const secret of [VISA, "123"]) assert.equal(out.includes(secret), false);
  await h.run("vault_fill", { entry: c.id, fields: [{ ref: "e5", field: "number" }] });
  assert.equal(h.asked.length, 1);
  h.page.address = "https://other-shop.example.org/";
  h.asked.length = 0;
  await h.run("vault_fill", { entry: c.id, fields: [{ ref: "e5", field: "number" }] });
  assert.equal(h.asked.length, 1, "another site is another question");
});

test("a contact fills its address", async () => {
  const h = setup({ address: "https://shop.example.com/", asks: ["allow"] });
  const k = h.vault.put({ kind: "contact", title: "Home", email: "ada@example.com", address: { name: "Ada", line1: "1 Main St", city: "London" } });
  const out = await h.run("vault_fill", { entry: k.id, fields: [{ ref: "e1", field: "name" }, { ref: "e2", field: "line1" }, { ref: "e3", field: "email" }] });
  assert.deepEqual(h.page.fills.map((f) => f.value), ["Ada", "1 Main St", "ada@example.com"]);
  assert.match(out, /Filled name, line1, email from "Home"/);
});

/* vault_fill: the page and the typing --------------------------------------- */

test("a page that moves while the person decides is not filled", async () => {
  const h = setup({ asks: ["allow"] });
  const saved = h.login();
  h.page.moveAfter = { reads: 1, to: "https://github.com.evil.example/" };
  const out = await h.run("vault_fill", fillBoth(saved.id));
  assert.match(out, /^ERROR: The page changed while waiting, so nothing was filled\./);
  assert.deepEqual(h.page.fills, []);
});

test("a field that cannot be filled stops the rest and says what was done", async () => {
  const h = setup({ asks: ["allow"] });
  const saved = h.login();
  h.page.failOn = "e2";
  const out = await h.run("vault_fill", fillBoth(saved.id));
  assert.match(out, /^ERROR: Filled username, but could not fill password into e2: Ref e2 is a button/);
  assert.equal(out.includes(PASSWORD), false);
  assert.deepEqual(h.page.fills, [{ ref: "e1", value: "ada" }]);
});

test("when the first field fails there is nothing to say was done", async () => {
  const h = setup({ asks: ["allow"] });
  const saved = h.login();
  h.page.failOn = "e1";
  assert.match(await h.run("vault_fill", fillBoth(saved.id)), /^ERROR: could not fill username into e1/);
  assert.deepEqual(h.page.fills, []);
});

test("submit presses Enter after the last field, and only when asked", async () => {
  const h = setup({ asks: ["allow-always"] });
  const saved = h.login();
  const plain = await h.run("vault_fill", fillBoth(saved.id));
  assert.equal(h.page.submits, 0);
  assert.doesNotMatch(plain, /pressed Enter/);
  const sent = await h.run("vault_fill", fillBoth(saved.id, { submit: true }));
  assert.equal(h.page.submits, 1);
  assert.match(sent, /and pressed Enter/);
  await h.run("vault_fill", fillBoth(saved.id, { submit: "yes" }));
  assert.equal(h.page.submits, 1, "only true submits");
});

test("a failed fill does not press Enter", async () => {
  const h = setup({ asks: ["allow"] });
  const saved = h.login();
  h.page.failOn = "e2";
  await h.run("vault_fill", fillBoth(saved.id, { submit: true }));
  assert.equal(h.page.submits, 0);
});

test("a tool call shows the name of what it fills, not its id", () => {
  const h = setup();
  const saved = h.login();
  assert.equal(h.tool("vault_fill").summarize({ entry: saved.id }), 'fill "GitHub" into the page');
  assert.equal(h.tool("vault_fill").summarize({ entry: "ghost" }), 'fill "a saved item" into the page');
  assert.equal(h.tool("vault_list").summarize({ site: "github.com" }), "list Vault for github.com");
  assert.equal(h.tool("vault_list").summarize({}), "list Vault");
});

/* request_takeover --------------------------------------------------------- */

test("the person is asked to take over, and the Bot learns how it went", async () => {
  const done = setup({ takeover: ["done"] });
  assert.match(await done.run("request_takeover", { reason: "Approve the sign-in on your phone." }), /finished and handed the browser back\. Take a fresh snapshot/);
  assert.deepEqual(done.takeovers, ["Approve the sign-in on your phone."]);
  const declined = setup({ takeover: ["declined"] });
  assert.match(await declined.run("request_takeover", { reason: "Solve the CAPTCHA." }), /did not take over\. Do not carry on with this step/);
});

test("a hand-over needs a reason, tidied and kept short", async () => {
  const h = setup({ takeover: ["done"] });
  assert.match(await h.run("request_takeover", { reason: "   " }), /^ERROR: reason is required/);
  assert.match(await h.run("request_takeover", {}), /^ERROR: reason is required/);
  assert.deepEqual(h.takeovers, []);
  await h.run("request_takeover", { reason: `  Sign   in\n${"x".repeat(400)}` });
  assert.equal(h.takeovers[0]?.startsWith("Sign in xxx"), true);
  assert.equal(h.takeovers[0]?.length, 301);
  assert.equal(h.takeovers[0]?.endsWith("…"), true);
});

test("with nobody there, a hand-over is an error that says what to report", async () => {
  const h = setup({ attended: false });
  assert.match(await h.run("request_takeover", { reason: "Solve the CAPTCHA." }), /^ERROR: Nobody is here to take over, so this cannot go on\. Stop and report that a person has to do this: Solve the CAPTCHA\./);
});

/* secure_form_fill --------------------------------------------------------- */

const form = (over: Record<string, unknown> = {}) => ({
  title: "Sign in to GitHub",
  reason: "Your saved login did not work.",
  fields: [
    { id: "user", label: "Username", ref: "e1" },
    { id: "pw", label: "Password", secret: true, ref: "e2" },
  ],
  ...over,
});

test("the form is shown with where it goes, and what is typed reaches the page, not the Bot", async () => {
  const h = setup({ form: [{ user: "ada", pw: "s3cret-value!" }] });
  const out = await h.run("secure_form_fill", form());
  assert.deepEqual(h.forms[0], {
    title: "Sign in to GitHub",
    reason: "Your saved login did not work.",
    host: "github.com",
    fields: [
      { id: "user", label: "Username", secret: false },
      { id: "pw", label: "Password", secret: true },
    ],
  });
  assert.deepEqual(h.page.fills, [{ ref: "e1", value: "ada" }, { ref: "e2", value: "s3cret-value!" }]);
  assert.match(out, /^Filled Username, Password on github\.com\. What the person typed is not shown to you\./);
  assert.equal(out.includes("s3cret-value!"), false);
  assert.deepEqual(h.hidden.sort(), ["ada", "s3cret-value!"], "typed values are hidden from now on");
});

test("a cancelled form types nothing", async () => {
  const h = setup({ form: [null] });
  assert.match(await h.run("secure_form_fill", form()), /did not fill in the form\. Do not carry on with this step/);
  assert.deepEqual(h.page.fills, []);
  assert.deepEqual(h.hidden, []);
  const empty = setup({ form: [{ user: "" }] });
  assert.match(await empty.run("secure_form_fill", form()), /did not fill in the form/);
});

test("only what was answered is typed, and nothing that was not asked for", async () => {
  const h = setup({ form: [{ pw: "only-this-one", sneaky: "x" }] });
  const out = await h.run("secure_form_fill", form());
  assert.deepEqual(h.page.fills, [{ ref: "e2", value: "only-this-one" }]);
  assert.match(out, /^Filled Password on github\.com/);
  assert.deepEqual(h.hidden, ["only-this-one"]);
});

test("a form is refused before it is shown when it is wrong or the page is not one to fill", async () => {
  const h = setup({ form: [{ user: "a" }] });
  assert.match(await h.run("secure_form_fill", form({ title: "" })), /^ERROR: title is required/);
  assert.match(await h.run("secure_form_fill", form({ fields: [] })), /^ERROR: fields must list at least one field/);
  assert.match(await h.run("secure_form_fill", form({ fields: [{ id: "a", label: "A", ref: "nope" }] })), /^ERROR: Field "a" needs a ref/);
  assert.deepEqual(h.forms, []);
  const http = setup({ address: "http://github.com/login", form: [{ user: "a" }] });
  assert.match(await http.run("secure_form_fill", form()), /^ERROR: .* is not somewhere a saved credential can be filled in/);
  assert.deepEqual(http.forms, []);
});

test("a form that moves the page while open types nothing", async () => {
  const h = setup({ form: [{ user: "ada" }] });
  h.page.moveAfter = { reads: 1, to: "https://evil.example/" };
  const out = await h.run("secure_form_fill", form());
  assert.match(out, /^ERROR: The page changed while the form was open, so nothing was filled\./);
  assert.deepEqual(h.page.fills, []);
});

test("a form field that cannot be filled says what was done and what failed", async () => {
  const h = setup({ form: [{ user: "ada", pw: "s3cret-value!" }] });
  h.page.failOn = "e2";
  const out = await h.run("secure_form_fill", form());
  assert.match(out, /^ERROR: Filled Username, but could not fill Password into e2/);
  assert.equal(out.includes("s3cret-value!"), false);
});

test("a form can press Enter, and with nobody there it cannot be asked", async () => {
  const h = setup({ form: [{ user: "ada" }] });
  assert.match(await h.run("secure_form_fill", form({ submit: true })), /and pressed Enter/);
  assert.equal(h.page.submits, 1);
  const away = setup({ attended: false });
  assert.match(await away.run("secure_form_fill", form()), /^ERROR: Nobody is here to fill in a form/);
  assert.deepEqual(away.page.fills, []);
});
