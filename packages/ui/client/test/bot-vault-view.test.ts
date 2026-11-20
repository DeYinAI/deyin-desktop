import assert from "node:assert/strict";
import test from "node:test";
import { VAULT_LIMITS, missingTranslations, parseVaultInput, translate, type VaultCard, type VaultContact, type VaultGrant, type VaultItem, type VaultLogin } from "@deyin/host-core/shared";
import {
  FORM_LIMITS,
  attemptVault,
  attemptVaultLoad,
  cardExpired,
  cardExpiry,
  emptyVaultForm,
  formFromItem,
  grantRows,
  groupItems,
  itemDetails,
  itemHeadline,
  splitList,
  vaultFormProblem,
  vaultPayload,
  type VaultForm,
} from "../src/bots/botVault.js";

/** A year the host accepts as a card's expiry whenever this runs. */
const FUTURE_YEAR = new Date().getFullYear() + 3;
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
  expYear: FUTURE_YEAR,
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
  address: { ...NO_ADDRESS, line1: "1 Analytical Way", city: "London", country: "UK" },
  defaultShipping: false,
  email: "ada@example.com",
  emails: [],
  phones: [],
  ...STAMPS,
  ...over,
});

/** A form for each kind that the host would accept as a new item. */
function validForm(kind: VaultForm["kind"]): VaultForm {
  const form = { ...emptyVaultForm(kind), title: "Something" };
  switch (kind) {
    case "login":
      return { ...form, username: "ada", password: "hunter22", sites: "github.com" };
    case "card":
      return { ...form, number: "4242 4242 4242 4242", expMonth: "12", expYear: String(FUTURE_YEAR) };
    case "contact":
      return { ...form, email: "ada@example.com" };
    default: {
      const unhandled: never = kind;
      throw new Error(String(unhandled));
    }
  }
}

test("a list of values is split on lines, commas and semicolons, trimmed, with blanks dropped", () => {
  assert.deepEqual(splitList("a.com\n b.com ,c.com;;\n\n d.com"), ["a.com", "b.com", "c.com", "d.com"]);
  assert.deepEqual(splitList("  \n , "), []);
  assert.deepEqual(splitList(""), []);
});

test("a form for changing an item shows everything it shows and never a secret", () => {
  const editLogin = formFromItem(login());
  assert.equal(editLogin.id, "l1");
  assert.equal(editLogin.username, "ada@example.com");
  assert.equal(editLogin.sites, "github.com");
  assert.equal(editLogin.password, "", "the Vault never sends a password back");
  assert.deepEqual(editLogin.saved, { password: true, securityCode: false, last4: "" });

  const editCard = formFromItem(card({ billingAddress: { ...NO_ADDRESS, line1: "9 Rue", city: "Paris" } }));
  assert.equal(editCard.number, "");
  assert.equal(editCard.securityCode, "");
  assert.equal(editCard.expMonth, "12");
  assert.equal(editCard.expYear, String(FUTURE_YEAR));
  assert.equal(editCard.billing.city, "Paris");
  assert.deepEqual(editCard.saved, { password: false, securityCode: true, last4: "4242" });

  const editContact = formFromItem(contact({ emails: ["a@b.co", "c@d.co"], phones: ["+44 20 7946 0000"], defaultShipping: true }));
  assert.equal(editContact.emails, "a@b.co\nc@d.co");
  assert.equal(editContact.phones, "+44 20 7946 0000");
  assert.equal(editContact.defaultShipping, true);
  assert.equal(editContact.address.line1, "1 Analytical Way");

  const noExpiry = formFromItem(card({ expMonth: 0, expYear: 0, billingAddress: null }));
  assert.equal(noExpiry.expMonth, "");
  assert.equal(noExpiry.billing.line1, "", "a card with no billing address starts with a blank one");
});

test("a new form starts blank for its kind", () => {
  for (const kind of ["login", "card", "contact"] as const) {
    const form = emptyVaultForm(kind);
    assert.equal(form.kind, kind);
    assert.equal(form.id, "");
    assert.equal(form.password + form.number + form.securityCode + form.title, "");
    assert.deepEqual(form.saved, { password: false, securityCode: false, last4: "" });
  }
});

test("Save is blocked by the first thing missing, in a fixed order", () => {
  assert.equal(vaultFormProblem(emptyVaultForm("login")), "vault.err.title");
  const named = { ...emptyVaultForm("login"), title: "x" };
  assert.equal(vaultFormProblem(named), "vault.err.username");
  assert.equal(vaultFormProblem({ ...named, username: "ada" }), "vault.err.sites");
  assert.equal(vaultFormProblem({ ...named, username: "ada", sites: " , \n" }), "vault.err.sites");
  assert.equal(vaultFormProblem({ ...named, username: "ada", sites: "a.com" }), "vault.err.password");
  assert.equal(vaultFormProblem({ ...named, username: "ada", sites: "a.com", password: "p" }), null);

  const cardForm = { ...emptyVaultForm("card"), title: "x" };
  assert.equal(vaultFormProblem(cardForm), "vault.err.number");
  assert.equal(vaultFormProblem({ ...cardForm, number: "4242424242424242" }), "vault.err.expiry");
  assert.equal(vaultFormProblem({ ...cardForm, number: "4242424242424242", expMonth: "1" }), "vault.err.expiry");
  assert.equal(vaultFormProblem({ ...cardForm, number: "4242424242424242", expMonth: "1", expYear: "2099" }), null);

  const contactForm = { ...emptyVaultForm("contact"), title: "x" };
  assert.equal(vaultFormProblem(contactForm), "vault.err.contact");
  assert.equal(vaultFormProblem({ ...contactForm, email: "a@b.co" }), null);
  assert.equal(vaultFormProblem({ ...contactForm, emails: "a@b.co" }), null);
  assert.equal(vaultFormProblem({ ...contactForm, phones: "123" }), null);
  assert.equal(vaultFormProblem({ ...contactForm, address: { ...NO_ADDRESS, line1: "1 Road" } }), null);
  assert.equal(vaultFormProblem({ ...contactForm, address: { ...NO_ADDRESS, city: "Only a city" } }), "vault.err.contact", "the host wants a first address line");
  assert.equal(vaultFormProblem({ ...validForm("login"), title: "   " }), "vault.err.title");
});

test("changing an item does not ask for a secret again, but adding one does", () => {
  assert.equal(vaultFormProblem(formFromItem(login())), null, "an empty password means keep");
  assert.equal(vaultFormProblem(formFromItem(card())), null, "an empty card number means keep");
  assert.equal(vaultFormProblem({ ...validForm("login"), password: "" }), "vault.err.password");
  assert.equal(vaultFormProblem({ ...validForm("card"), number: "" }), "vault.err.number");
  assert.equal(vaultFormProblem({ ...formFromItem(login()), sites: "" }), "vault.err.sites", "an update still names its sites");
  assert.equal(vaultFormProblem({ ...formFromItem(card()), expYear: "" }), "vault.err.expiry", "an update still names its expiry");
});

test("the form and the host agree: whatever the form lets through, the host accepts, and what it blocks the host refuses", () => {
  for (const kind of ["login", "card", "contact"] as const) {
    const form = validForm(kind);
    assert.equal(vaultFormProblem(form), null, kind);
    assert.doesNotThrow(() => parseVaultInput(vaultPayload(form), "create"), kind);
  }
  const blocked: VaultForm[] = [
    emptyVaultForm("login"),
    { ...validForm("login"), username: "" },
    { ...validForm("login"), sites: "" },
    { ...validForm("login"), password: "" },
    { ...validForm("card"), number: "" },
    { ...validForm("card"), expMonth: "" },
    { ...validForm("card"), expYear: "" },
    { ...validForm("contact"), email: "" },
    { ...validForm("contact"), title: "" },
  ];
  for (const form of blocked) {
    assert.notEqual(vaultFormProblem(form), null);
    assert.throws(() => parseVaultInput(vaultPayload(form), "create"), undefined, JSON.stringify({ ...form, password: "…" }));
  }
});

test("changing an item sends what the host takes as an update, and a secret left empty is left out", () => {
  for (const item of [login(), card(), contact({ emails: ["x@y.co"], phones: ["+44 20 7946 0000"] })] satisfies VaultItem[]) {
    const payload = vaultPayload(formFromItem(item));
    assert.equal(payload.id, item.id);
    assert.doesNotThrow(() => parseVaultInput(payload, "update"), item.kind);
    for (const secret of ["password", "number", "securityCode"]) assert.equal(Object.hasOwn(payload, secret), false, `${item.kind} sends no ${secret}`);
  }
  const typed = vaultPayload({ ...formFromItem(login()), password: "new-one" });
  assert.equal(typed.password, "new-one");
});

test("the payload is trimmed and split, and only a secret that was typed is sent", () => {
  const login1 = vaultPayload({ ...validForm("login"), title: "  GitHub ", username: " ada ", sites: " a.com\n b.com,c.com ", password: " keep my spaces " });
  assert.deepEqual(login1, { kind: "login", title: "GitHub", notes: "", username: "ada", sites: ["a.com", "b.com", "c.com"], password: " keep my spaces " });

  const card1 = vaultPayload({ ...validForm("card"), securityCode: " 123 ", holderName: " Ada ", billing: { ...NO_ADDRESS, line1: " 1 Road " } });
  assert.equal(card1.number, "4242 4242 4242 4242");
  assert.equal(card1.securityCode, "123");
  assert.equal(card1.holderName, "Ada");
  assert.equal((card1.billingAddress as { line1: string }).line1, "1 Road");
  assert.equal(Object.hasOwn(vaultPayload({ ...validForm("card"), securityCode: "  " }), "securityCode"), false);

  const contact1 = vaultPayload({ ...validForm("contact"), emails: "a@b.co\nc@d.co", phones: "1\n2", defaultShipping: true });
  assert.deepEqual(contact1.emails, ["a@b.co", "c@d.co"]);
  assert.deepEqual(contact1.phones, ["1", "2"]);
  assert.equal(contact1.defaultShipping, true);
  assert.equal(Object.hasOwn(vaultPayload(validForm("login")), "id"), false, "a new item has no id");
});

test("the text limits are the host's", () => {
  assert.equal(FORM_LIMITS.title, VAULT_LIMITS.title);
  assert.equal(FORM_LIMITS.notes, VAULT_LIMITS.notes);
  assert.equal(FORM_LIMITS.username, VAULT_LIMITS.username);
  assert.equal(FORM_LIMITS.password, VAULT_LIMITS.password);
  assert.equal(FORM_LIMITS.line, VAULT_LIMITS.line);
  assert.equal(FORM_LIMITS.email, VAULT_LIMITS.email);
});

test("each kind has a headline and detail lines that say which item it is", () => {
  assert.equal(itemHeadline(login()), "ada@example.com");
  assert.deepEqual(itemDetails(login({ sites: ["github.com", "gist.github.com"] })), ["github.com, gist.github.com"]);

  assert.equal(itemHeadline(card()), "Visa •••• 4242");
  assert.equal(itemHeadline(card({ brand: "amex", last4: "0005" })), "American Express •••• 0005");
  assert.equal(itemHeadline(card({ brand: "unknown" })), "Card •••• 4242");
  assert.deepEqual(itemDetails(card()), ["Ada Lovelace"]);
  assert.deepEqual(itemDetails(card({ holderName: "" })), []);
});

test("a contact leads with its email, else its first phone, else its address, and never repeats the lead", () => {
  const withEmail = contact({ email: "ada@example.com", emails: ["b@x.co"], phones: ["111", "222"] });
  assert.equal(itemHeadline(withEmail), "ada@example.com");
  assert.deepEqual(itemDetails(withEmail), ["1 Analytical Way, London, UK", "b@x.co", "111", "222"]);

  const phoneOnly = contact({ email: "", emails: ["b@x.co"], phones: ["111", "222"] });
  assert.equal(itemHeadline(phoneOnly), "111");
  assert.deepEqual(itemDetails(phoneOnly), ["1 Analytical Way, London, UK", "b@x.co", "222"]);

  const addressOnly = contact({ email: "", emails: [], phones: [] });
  assert.equal(itemHeadline(addressOnly), "1 Analytical Way, London, UK");
  assert.deepEqual(itemDetails(addressOnly), []);

  const nothingElse = contact({ email: "ada@example.com", address: { ...NO_ADDRESS }, emails: [], phones: [] });
  assert.deepEqual(itemDetails(nothingElse), []);
});

test("a card's expiry reads MM/YY, and is empty when it has none", () => {
  assert.equal(cardExpiry(card({ expMonth: 3, expYear: 2027 })), "03/27");
  assert.equal(cardExpiry(card({ expMonth: 12, expYear: 2105 })), "12/05");
  assert.equal(cardExpiry(card({ expMonth: 0, expYear: 2027 })), "");
  assert.equal(cardExpiry(card({ expMonth: 3, expYear: 0 })), "");
});

test("a card is good through the end of its expiry month", () => {
  const march = card({ expMonth: 3, expYear: 2026 });
  assert.equal(cardExpired(march, new Date(2026, 2, 1)), false);
  assert.equal(cardExpired(march, new Date(2026, 2, 31, 23, 59)), false);
  assert.equal(cardExpired(march, new Date(2026, 3, 1)), true);
  assert.equal(cardExpired(march, new Date(2025, 11, 31)), false);
  assert.equal(cardExpired(march, new Date(2027, 0, 1)), true);
  assert.equal(cardExpired(card({ expMonth: 12, expYear: 2025 }), new Date(2026, 0, 1)), true);
  assert.equal(cardExpired(card({ expMonth: 0, expYear: 0 }), new Date(2090, 0, 1)), false, "no expiry is never expired");
});

test("items are grouped logins, cards, contacts, and an empty group is left out", () => {
  const items: VaultItem[] = [contact({ id: "p1" }), login({ id: "l1" }), card({ id: "c1" }), login({ id: "l2" })];
  assert.deepEqual(
    groupItems(items).map((g) => [g.kind, g.items.map((i) => i.id)]),
    [
      ["login", ["l1", "l2"]],
      ["card", ["c1"]],
      ["contact", ["p1"]],
    ],
  );
  assert.deepEqual(groupItems([card()]).map((g) => g.kind), ["card"]);
  assert.deepEqual(groupItems([]), []);
});

test("who may use an item is listed newest first, by name, and a deleted Bot has no name", () => {
  const grants: VaultGrant[] = [
    { botId: "b1", itemId: "l1", host: "github.com", grantedAt: 10 },
    { botId: "gone", itemId: "l1", host: "gist.github.com", grantedAt: 30 },
    { botId: "b2", itemId: "l1", host: "github.com", grantedAt: 20 },
    { botId: "b1", itemId: "other", host: "elsewhere.com", grantedAt: 99 },
  ];
  const rows = grantRows(grants, "l1", [
    { id: "b1", name: "Scout" },
    { id: "b2", name: "Pilot" },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.botId, r.botName, r.host]),
    [
      ["gone", null, "gist.github.com"],
      ["b2", "Pilot", "github.com"],
      ["b1", "Scout", "github.com"],
    ],
  );
  assert.deepEqual(grantRows(grants, "nothing", []), []);
});

test("a Vault call gives its value, or the reason it was refused, and never throws", async () => {
  assert.deepEqual(await attemptVault(async () => ({ ok: true as const, value: 7 })), { ok: true, value: 7 });
  assert.deepEqual(await attemptVault(async () => ({ ok: false as const, error: "That card has expired." })), { ok: false, error: "That card has expired." });
  assert.deepEqual(
    await attemptVault(async () => {
      throw new Error("ipc closed");
    }),
    { ok: false, error: "ipc closed" },
  );
  assert.deepEqual(
    await attemptVault(async () => {
      throw "plain text";
    }),
    { ok: false, error: "plain text" },
  );
});

test("loading the Vault gives the snapshot, or the reason it failed", async () => {
  const snapshot = { items: [login()], grants: [], protection: "encrypted" as const };
  assert.deepEqual(await attemptVaultLoad({ get: async () => snapshot }), { ok: true, value: snapshot });
  assert.deepEqual(
    await attemptVaultLoad({
      get: async () => {
        throw new Error("no host");
      },
    }),
    { ok: false, error: "no host" },
  );
});

test("every Vault string has text in every language, and the form's messages are real text", () => {
  for (const locale of ["zh", "de"] as const) {
    const missing = missingTranslations(locale).filter((key) => key.startsWith("vault.") || key.startsWith("bot.secureForm.") || key === "settings.nav.vault" || key === "settings.section.bot");
    assert.deepEqual(missing, [], locale);
  }
  const problems = [
    vaultFormProblem(emptyVaultForm("login")),
    vaultFormProblem({ ...emptyVaultForm("login"), title: "x" }),
    vaultFormProblem({ ...emptyVaultForm("login"), title: "x", username: "u" }),
    vaultFormProblem({ ...emptyVaultForm("login"), title: "x", username: "u", sites: "a.com" }),
    vaultFormProblem({ ...emptyVaultForm("card"), title: "x" }),
    vaultFormProblem({ ...emptyVaultForm("card"), title: "x", number: "1" }),
    vaultFormProblem({ ...emptyVaultForm("contact"), title: "x" }),
  ];
  assert.equal(new Set(problems).size, 7, "title, username, sites, password, number, expiry and contact are each their own message");
  for (const key of problems) {
    assert.ok(key);
    assert.notEqual(translate("en", key), key);
  }
});
