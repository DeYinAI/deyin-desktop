import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VaultCard, VaultContact, VaultGrant, VaultItem, VaultLogin, VaultProtection } from "@deyin/host-core/shared";
import { VaultPanel, type VaultPanelProps, type VaultState } from "../src/bots/VaultPanel.js";
import { emptyVaultForm, formFromItem, type VaultForm } from "../src/bots/botVault.js";

const noop = () => undefined;
const NOW = new Date(2026, 5, 15);
const NO_ADDRESS = { name: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "", phone: "" };
const STAMPS = { notes: "", createdAt: 1, updatedAt: 1 };

const login = (over: Partial<VaultLogin> = {}): VaultLogin => ({ id: "l1", kind: "login", title: "GitHub", username: "ada@example.com", sites: ["github.com"], hasPassword: true, ...STAMPS, ...over });
const card = (over: Partial<VaultCard> = {}): VaultCard => ({
  id: "c1",
  kind: "card",
  title: "Work card",
  brand: "visa",
  last4: "4242",
  expMonth: 12,
  expYear: 2029,
  holderName: "Ada Lovelace",
  billingAddress: null,
  hasSecurityCode: true,
  ...STAMPS,
  ...over,
});
const contact = (over: Partial<VaultContact> = {}): VaultContact => ({
  id: "p1",
  kind: "contact",
  title: "Home",
  address: { ...NO_ADDRESS, line1: "1 Analytical Way", city: "London" },
  defaultShipping: true,
  email: "ada@example.com",
  emails: [],
  phones: [],
  ...STAMPS,
  ...over,
});

const ready = (items: VaultItem[], grants: VaultGrant[] = [], protection: VaultProtection = "encrypted"): VaultState => ({ status: "ready", snapshot: { items, grants, protection } });

interface Over extends Partial<Omit<VaultPanelProps, "state">> {
  state?: VaultState;
}

function render(over: Over = {}): string {
  return renderToStaticMarkup(
    createElement(VaultPanel, {
      state: over.state ?? ready([]),
      bots: over.bots ?? [],
      editor: over.editor ?? null,
      busy: over.busy ?? false,
      error: over.error ?? null,
      now: over.now ?? NOW,
      ...(over.onePassword ? { onePassword: over.onePassword } : {}),
      onAdd: noop,
      onEdit: noop,
      onRemove: noop,
      onRevoke: noop,
      onForm: noop,
      onSave: noop,
      onCancel: noop,
    }),
  );
}

/** The first tag of `html` that matches `pattern`, to read its attributes. */
function tag(html: string, pattern: RegExp): string {
  const found = pattern.exec(html);
  assert.ok(found, `no tag matching ${pattern}`);
  return found[0];
}

const completeLogin = (): VaultForm => ({ ...emptyVaultForm("login"), title: "GitHub", username: "ada", sites: "github.com", password: "hunter22" });

test("the page says what the Vault is for, with an Add button for each kind", () => {
  const html = render();
  assert.match(html, /<h1>Vault<\/h1>/);
  assert.match(html, /A Bot never sees a password or a card number/);
  const buttons = [...html.matchAll(/<button[^>]*>(Add [a-z]+)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(buttons, ["Add login", "Add card", "Add contact"]);
});

test("Add waits while loading, after a failure, while a form is open, and while saving", () => {
  const disabled = (html: string): boolean[] => [...html.matchAll(/<button([^>]*)>Add (?:login|card|contact)<\/button>/g)].map((m) => /disabled/.test(m[1] ?? ""));
  assert.deepEqual(disabled(render()), [false, false, false]);
  assert.deepEqual(disabled(render({ state: { status: "loading" } })), [true, true, true]);
  assert.deepEqual(disabled(render({ state: { status: "error", error: "x" } })), [true, true, true]);
  assert.deepEqual(disabled(render({ editor: emptyVaultForm("login") })), [true, true, true]);
  assert.deepEqual(disabled(render({ busy: true })), [true, true, true]);
});

test("while loading or after a failure there is a message and no list", () => {
  const loading = render({ state: { status: "loading" } });
  assert.match(loading, /role="status">Loading the Vault…/);
  assert.doesNotMatch(loading, /vault__protection|Nothing saved yet/);
  const failed = render({ state: { status: "error", error: "ipc closed" } });
  assert.match(failed, /role="alert">Couldn&#x27;t load the Vault\. ipc closed/);
  assert.doesNotMatch(failed, /vault__protection|Nothing saved yet/);
});

test("it says whether secrets are encrypted or only protected by file permissions, and the second looks like a warning", () => {
  const encrypted = render({ state: ready([], [], "encrypted") });
  assert.match(encrypted, /vault__protection--encrypted"[^>]*>Passwords, card numbers and security codes are encrypted with your computer&#x27;s keychain\./);
  const plain = render({ state: ready([], [], "file-permissions") });
  assert.match(plain, /vault__protection--file-permissions"[^>]*>This computer has no keychain available/);
  assert.match(plain, /Anyone who can read your files can read them\./);
  assert.doesNotMatch(plain, /encrypted with your computer/);
});

test("an empty Vault says so", () => {
  assert.match(render(), /Nothing saved yet\. Add a login, a card or a contact for your Bots to use\./);
  assert.doesNotMatch(render({ state: ready([login()]) }), /Nothing saved yet/);
});

test("items are listed by kind, logins then cards then contacts, each under its heading", () => {
  const html = render({ state: ready([contact(), card(), login()]) });
  const headings = [...html.matchAll(/<h3 class="bot-detail__subheading">([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(headings, ["Logins", "Cards", "Contacts"]);
  assert.ok(html.indexOf("GitHub") < html.indexOf("Work card") && html.indexOf("Work card") < html.indexOf("Home"));
  assert.doesNotMatch(render({ state: ready([card()]) }), /<h3 class="bot-detail__subheading">(?:Logins|Contacts)/, "a kind with nothing in it has no heading");
});

test("each item shows what it is without a secret, with Edit and Remove named for it", () => {
  const html = render({ state: ready([login({ sites: ["github.com", "gist.github.com"] }), card({ holderName: "Ada Lovelace" })]) });
  assert.match(html, /vault-item__title">GitHub</);
  assert.match(html, /vault-item__headline">ada@example\.com</);
  assert.match(html, /github\.com, gist\.github\.com/);
  assert.match(html, /vault-item__headline">Visa •••• 4242</);
  assert.match(html, />Ada Lovelace</);
  for (const name of ["GitHub", "Work card"]) {
    assert.match(html, new RegExp(`aria-label="Edit: ${name}"`));
    assert.match(html, new RegExp(`aria-label="Remove: ${name}"`));
  }
});

test("the page never shows a secret, even from a host that sent one by mistake", () => {
  const leaky = { ...login(), password: "TOP-SECRET-PW", number: "4242424242424242", securityCode: "987" } as VaultItem;
  const html = render({ state: ready([leaky, card({ ...({ number: "4242424242424242", securityCode: "987" } as object) })]) });
  assert.doesNotMatch(html, /TOP-SECRET-PW|4242424242424242|987/);
});

test("a card says when it expires, and says so in warning colours when it has", () => {
  const good = render({ state: ready([card({ expMonth: 12, expYear: 2029 })]) });
  assert.match(good, /<span class="hint">Expires 12\/29<\/span>/);
  const expired = render({ state: ready([card({ expMonth: 5, expYear: 2026 })]) });
  assert.match(expired, /<span class="hint--bad">Expired 05\/26<\/span>/);
  const thisMonth = render({ state: ready([card({ expMonth: 6, expYear: 2026 })]) });
  assert.match(thisMonth, /Expires 06\/26/, "good through the end of its month");
  assert.doesNotMatch(render({ state: ready([card({ expMonth: 0, expYear: 0 })]) }), /Expire/);
});

test("a contact says when it is the default shipping address, and notes show", () => {
  assert.match(render({ state: ready([contact({ defaultShipping: true })]) }), />Default shipping</);
  assert.doesNotMatch(render({ state: ready([contact({ defaultShipping: false })]) }), /Default shipping/);
  assert.match(render({ state: ready([login({ notes: "Work account" })]) }), />Work account</);
});

test("who may use an item is listed by Bot name and site, with a Take back that names both", () => {
  const grants: VaultGrant[] = [
    { botId: "b1", itemId: "l1", host: "github.com", grantedAt: 10 },
    { botId: "gone", itemId: "l1", host: "gist.github.com", grantedAt: 20 },
    { botId: "b1", itemId: "elsewhere", host: "other.com", grantedAt: 30 },
  ];
  const html = render({ state: ready([login()], grants), bots: [{ id: "b1", name: "Scout" }] });
  assert.match(html, /Bots that may use this/);
  assert.match(html, /bot-permission__name">Scout on github\.com</);
  assert.match(html, /bot-permission__name">A deleted Bot on gist\.github\.com</);
  assert.match(html, /aria-label="Take back: Scout on github\.com"/);
  assert.doesNotMatch(html, /other\.com/, "another item's permission is not listed here");
  assert.doesNotMatch(render({ state: ready([login()]) }), /Bots that may use this/, "nothing allowed, nothing listed");
});

test("Edit, Remove and Take back wait while something is saving", () => {
  const grants: VaultGrant[] = [{ botId: "b1", itemId: "l1", host: "github.com", grantedAt: 1 }];
  const html = render({ state: ready([login()], grants), bots: [{ id: "b1", name: "Scout" }], busy: true });
  const buttons = [...html.matchAll(/<button([^>]*aria-label="(?:Edit|Remove|Take back)[^>]*)>/g)];
  assert.equal(buttons.length, 3);
  for (const button of buttons) assert.match(button[1] ?? "", /disabled/);
});

test("a refusal of a remove or a take-back shows on the page, and one from the form shows only in the form", () => {
  const onPage = render({ state: ready([login()]), error: "Could not remove it." });
  assert.equal([...onPage.matchAll(/Could not remove it\./g)].length, 1);
  assert.match(onPage, /role="alert">Could not remove it\./);
  assert.doesNotMatch(render({ state: ready([login()]) }), /role="alert">[^<]/);

  const inForm = render({ state: ready([login()]), editor: completeLogin(), error: "That card has expired." });
  assert.equal([...inForm.matchAll(/That card has expired\./g)].length, 1);
});

test("adding a login asks for its name, username, password and sites, and the password is masked and never shown again", () => {
  const html = render({ editor: emptyVaultForm("login") });
  assert.match(html, /aria-label="Add a login"/);
  for (const label of ["Name", "Username or email", "Password", "Sites", "Notes"]) assert.match(html, new RegExp(`>${label}</label>`), label);
  const password = tag(html, /<input id="vault-password"[^>]*>/);
  assert.match(password, /type="password"/);
  assert.match(password, /autoComplete="new-password"/);
  assert.match(html, /It is saved but never shown again\./);
  assert.match(html, /The login is only ever used on these sites and their subdomains\./);
  assert.match(html, /<textarea id="vault-sites"/);
  assert.doesNotMatch(html, /vault-number|vault-email/);
});

test("changing a login names it, leaves the password blank, and says a saved one stays unless replaced", () => {
  const html = render({ state: ready([login()]), editor: formFromItem(login()) });
  assert.match(html, /aria-label="Edit “GitHub”"/);
  assert.match(tag(html, /<input id="vault-password"[^>]*>/), /value=""/);
  assert.match(html, /Saved\. Leave blank to keep it\./);
  assert.doesNotMatch(html, /It is saved but never shown again/);
  assert.match(tag(html, /<input id="vault-username"[^>]*>/), /value="ada@example\.com"/);
});

test("a card form masks the security code, keeps the number visible to check, and says what is saved", () => {
  const adding = render({ editor: emptyVaultForm("card") });
  assert.match(adding, /aria-label="Add a card"/);
  assert.match(tag(adding, /<input id="vault-security-code"[^>]*>/), /type="password"/);
  assert.match(tag(adding, /<input id="vault-number"[^>]*>/), /type="text"/);
  assert.match(tag(adding, /<input id="vault-number"[^>]*>/), /inputMode="numeric"/);
  assert.equal([...adding.matchAll(/It is saved but never shown again\./g)].length, 2, "the number and the security code");
  for (const label of ["Card number", "Security code", "Expiry month", "Expiry year", "Name on card", "Billing address", "Address line 1", "Postal code"]) assert.match(adding, new RegExp(`${label}`), label);

  const editing = render({ editor: formFromItem(card()) });
  assert.match(editing, /Saved, ending 4242\. Leave blank to keep it\./);
  assert.match(editing, /Saved\. Leave blank to keep it\./);
  assert.match(tag(editing, /<input id="vault-exp-month"[^>]*>/), /value="12"/);
  const noCode = render({ editor: formFromItem(card({ hasSecurityCode: false })) });
  assert.match(noCode, /It is saved but never shown again\./, "no code saved yet, so none to keep");
});

test("a contact form has its emails, phones, address and the default-shipping box", () => {
  const html = render({ editor: formFromItem(contact({ emails: ["b@x.co"], phones: ["+44 1"] })) });
  assert.match(html, /aria-label="Edit “Home”"/);
  for (const label of ["Email", "Other emails", "Phone numbers", "Address", "Use as the default shipping address"]) assert.match(html, new RegExp(label), label);
  assert.match(tag(html, /<input type="checkbox"[^>]*>/), /checked=""/);
  assert.match(html, /<textarea id="vault-emails"[^>]*>b@x\.co<\/textarea>/);
  assert.doesNotMatch(html, /vault-password|vault-number/);
});

test("Save is off until the form is complete, says what is missing, and is on when it is", () => {
  const save = (html: string): string => tag(html, /<button type="submit"[^>]*>/);
  const incomplete = render({ editor: emptyVaultForm("login") });
  assert.match(save(incomplete), /disabled/);
  assert.match(incomplete, /<p class="hint">Give it a name\.<\/p>/);
  const complete = render({ editor: completeLogin() });
  assert.doesNotMatch(save(complete), /disabled/);
  assert.doesNotMatch(complete, /Give it a name|Enter the/);
  assert.match(render({ editor: { ...completeLogin(), password: "" } }), /Enter the password\./);
});

test("while saving, the fields and both buttons wait and Save says so", () => {
  const html = render({ editor: completeLogin(), busy: true });
  assert.match(html, /<fieldset class="vault-form__body" disabled="">/);
  assert.match(html, />Saving…</);
  assert.doesNotMatch(html, />Save</);
  assert.match(tag(html, /<button type="submit"[^>]*>/), /disabled/);
  assert.match(tag(html, /<button type="button"[^>]*>Cancel/), /disabled/);
  assert.match(render({ editor: completeLogin() }), />Save</);
});

test("the form's inputs stop typing where the host would refuse", () => {
  const html = render({ editor: completeLogin() });
  assert.match(tag(html, /<input id="vault-title"[^>]*>/), /maxLength="120"/);
  assert.match(tag(html, /<input id="vault-password"[^>]*>/), /maxLength="1024"/);
  assert.match(tag(html, /<input id="vault-username"[^>]*>/), /maxLength="320"/);
  const cardHtml = render({ editor: emptyVaultForm("card") });
  assert.match(tag(cardHtml, /<input id="vault-security-code"[^>]*>/), /maxLength="4"/);
  assert.match(tag(cardHtml, /<input id="vault-exp-month"[^>]*>/), /maxLength="2"/);
  assert.match(tag(cardHtml, /<input id="vault-exp-year"[^>]*>/), /maxLength="4"/);
});

test("every field has a label tied to it", () => {
  for (const kind of ["login", "card", "contact"] as const) {
    const html = render({ editor: emptyVaultForm(kind) });
    const ids = [...html.matchAll(/<(?:input|textarea) id="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length >= 4, kind);
    for (const id of ids) assert.match(html, new RegExp(`<label class="field__label" for="${id}">`), `${kind}: ${id}`);
    assert.equal(new Set(ids).size, ids.length, `${kind}: ids are unique`);
  }
});

test("the 1Password switch is shown only when the host has the setting, and says what it does", () => {
  assert.ok(!render().includes("1Password"), "no card without the setting");
  const html = render({ onePassword: { enabled: false, onChange: noop } });
  assert.match(html, /Sign in with 1Password/);
  assert.match(html, /asks you every time/);
  assert.match(html, /routines never use it/);
  assert.match(tag(html, /<button[^>]*role="switch"[^>]*>/), /aria-label="Let Bots use 1Password"/);
});

test("the 1Password switch reads on or off from the setting", () => {
  const off = tag(render({ onePassword: { enabled: false, onChange: noop } }), /<button[^>]*role="switch"[^>]*>/);
  const on = tag(render({ onePassword: { enabled: true, onChange: noop } }), /<button[^>]*role="switch"[^>]*>/);
  assert.match(off, /aria-checked="false"/);
  assert.match(on, /aria-checked="true"/);
});
