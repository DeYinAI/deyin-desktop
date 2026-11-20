import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REDACTED,
  VAULT_FIELDS,
  VAULT_LIMITS,
  cardBrand,
  cardDigits,
  isStoredVaultItem,
  isVaultField,
  isVaultGrant,
  luhnValid,
  parseVaultInput,
  redactSecrets,
  resolveVaultField,
  secretForms,
  viewOf,
  type StoredVaultItem,
} from "../src/bots/vault.js";
import { BotError } from "../src/bots/types.js";

const NOW = new Date(2026, 5, 1);
const VISA = "4242424242424242";
const AMEX = "378282246310005";

const refused = (fn: () => unknown, pattern: RegExp): void => {
  assert.throws(fn, (error) => error instanceof BotError && error.code === "invalid" && pattern.test(error.message));
};

const login = (over: Record<string, unknown> = {}) => ({ kind: "login", title: "GitHub", username: "ada", password: "hunter2hunter2", sites: ["github.com"], ...over });
const card = (over: Record<string, unknown> = {}) => ({ kind: "card", title: "Visa", number: VISA, expMonth: 4, expYear: 2029, holderName: "Ada Lovelace", ...over });
const contact = (over: Record<string, unknown> = {}) => ({ kind: "contact", title: "Home", email: "ada@example.com", address: { line1: "1 Main St", city: "London" }, ...over });

/* Cards ------------------------------------------------------------------- */

test("card numbers are checked with the Luhn sum", () => {
  assert.equal(luhnValid(VISA), true);
  assert.equal(luhnValid(AMEX), true);
  assert.equal(luhnValid("4242424242424241"), false);
  assert.equal(luhnValid("0000000000000000"), true);
  assert.equal(luhnValid(""), false);
  assert.equal(luhnValid("42a2"), false);
  assert.equal(cardDigits("4242 4242-4242 4242"), VISA);
});

test("the card brand comes from the number's leading digits", () => {
  const cases: Array<[string, string]> = [
    [VISA, "visa"],
    ["5555555555554444", "mastercard"],
    ["2221000000000009", "mastercard"],
    ["2720990000000007", "mastercard"],
    ["2721000000000000", "unknown"],
    [AMEX, "amex"],
    ["6011111111111117", "discover"],
    ["6500000000000002", "discover"],
    ["6440000000000000", "discover"],
    ["6490000000000000", "discover"],
    ["6430000000000000", "unknown"],
    ["3800000000000000", "diners"],
    ["3600000000000000", "diners"],
    ["30569309025904", "diners"],
    ["3530111333300000", "jcb"],
    ["6200000000000005", "unionpay"],
    ["9999999999999995", "unknown"],
  ];
  for (const [number, brand] of cases) assert.equal(cardBrand(number), brand, number);
});

/* Logins ------------------------------------------------------------------ */

test("a login is checked and its sites turned into hosts", () => {
  const draft = parseVaultInput(login({ sites: ["https://Login.GitHub.com/x", "github.com", "github.com"], notes: "  work\r\naccount " }), "create");
  assert.equal(draft.kind, "login");
  assert.equal(draft.title, "GitHub");
  assert.equal(draft.notes, "work\naccount");
  assert.deepEqual(draft.data, { username: "ada", sites: ["login.github.com", "github.com"] });
  assert.deepEqual(draft.secrets, { password: "hunter2hunter2" });
});

test("a login needs a name, a username, a site and (when new) a password", () => {
  refused(() => parseVaultInput(login({ title: "  " }), "create"), /name is required/);
  refused(() => parseVaultInput(login({ username: "" }), "create"), /username is required/);
  refused(() => parseVaultInput(login({ sites: [] }), "create"), /at least one site/);
  refused(() => parseVaultInput(login({ sites: undefined }), "create"), /at least one site/);
  refused(() => parseVaultInput(login({ password: "" }), "create"), /needs a password/);
  refused(() => parseVaultInput(login({ password: undefined }), "create"), /needs a password/);
});

test("a site that cannot be saved is named in the refusal", () => {
  refused(() => parseVaultInput(login({ sites: ["github.com", "co.uk"] }), "create"), /"co\.uk" is not a site/);
  refused(() => parseVaultInput(login({ sites: ["ftp://x.example"] }), "create"), /is not a site/);
  refused(() => parseVaultInput(login({ sites: "github.com" }), "create"), /Sites must be a list/);
  refused(() => parseVaultInput(login({ sites: Array.from({ length: VAULT_LIMITS.sites + 1 }, (_, i) => `s${i}.example.com`) }), "create"), /at most 20/);
});

test("a password may hold anything but a line break, and has a size limit", () => {
  assert.equal(parseVaultInput(login({ password: " pa ss:wörd!\t" }), "create").secrets.password, " pa ss:wörd!\t");
  refused(() => parseVaultInput(login({ password: "a\nb" }), "create"), /line break/);
  refused(() => parseVaultInput(login({ password: "a\u0000b" }), "create"), /line break/);
  refused(() => parseVaultInput(login({ password: "x".repeat(VAULT_LIMITS.password + 1) }), "create"), /too long/);
  assert.equal(parseVaultInput(login({ password: "x".repeat(VAULT_LIMITS.password) }), "create").secrets.password?.length, VAULT_LIMITS.password);
  refused(() => parseVaultInput(login({ password: 12345 }), "create"), /must be text/);
});

test("changing a login may leave the password out to keep it", () => {
  const draft = parseVaultInput({ ...login({ id: "v1" }), password: undefined }, "update");
  assert.deepEqual(draft.secrets, {});
  assert.equal(draft.id, "v1");
  refused(() => parseVaultInput(login(), "update"), /Say which item/);
});

test("anything that is not an object, or has no valid kind, is refused", () => {
  for (const bad of [null, undefined, "x", 3, [], { title: "x" }, { kind: "note", title: "x" }, { kind: 1 }]) {
    refused(() => parseVaultInput(bad, "create"), /./);
  }
});

test("titles lose control characters and have a limit", () => {
  assert.equal(parseVaultInput(login({ title: "Git\u0007Hub\n" }), "create").title, "Git Hub");
  refused(() => parseVaultInput(login({ title: "x".repeat(VAULT_LIMITS.title + 1) }), "create"), /too long/);
  refused(() => parseVaultInput(login({ notes: "x".repeat(VAULT_LIMITS.notes + 1) }), "create"), /Notes are too long/);
  refused(() => parseVaultInput(login({ notes: 5 }), "create"), /Notes must be text/);
});

/* Cards ------------------------------------------------------------------- */

test("a card keeps its brand and last four, and its number and code as secrets", () => {
  const draft = parseVaultInput(card({ number: "4242 4242 4242 4242", securityCode: "123", billingAddress: { line1: "1 Main St", postalCode: "N1" } }), "create", NOW);
  assert.equal(draft.data.brand, "visa");
  assert.equal(draft.data.last4, "4242");
  assert.deepEqual(draft.secrets, { number: VISA, securityCode: "123" });
  assert.equal(JSON.stringify(draft.data).includes(VISA), false, "the number is not among the plain fields");
  assert.deepEqual((draft.data.billingAddress as { line1: string }).line1, "1 Main St");
});

test("a card without a billing address has none", () => {
  assert.equal(parseVaultInput(card(), "create", NOW).data.billingAddress, null);
  assert.equal(parseVaultInput(card({ billingAddress: { line1: "   " } }), "create", NOW).data.billingAddress, null);
});

test("a card number must be valid, and is required when creating", () => {
  refused(() => parseVaultInput(card({ number: "4242424242424241" }), "create", NOW), /not a valid card number/);
  refused(() => parseVaultInput(card({ number: "1234" }), "create", NOW), /not a valid card number/);
  refused(() => parseVaultInput(card({ number: "4242x424242424242" }), "create", NOW), /not a valid card number/);
  refused(() => parseVaultInput(card({ number: undefined }), "create", NOW), /needs its number/);
  const kept = parseVaultInput({ ...card({ id: "c1" }), number: undefined }, "update", NOW);
  assert.deepEqual(kept.secrets, {});
  assert.equal("brand" in kept.data, false);
  assert.equal("last4" in kept.data, false);
});

test("a security code is three or four digits", () => {
  assert.equal(parseVaultInput(card({ securityCode: "1234" }), "create", NOW).secrets.securityCode, "1234");
  for (const bad of ["12", "12345", "abc", "12 3"]) refused(() => parseVaultInput(card({ securityCode: bad }), "create", NOW), /3 or 4 digits/);
});

test("the expiry is a real month and a plausible year; two-digit years are this century", () => {
  assert.equal(parseVaultInput(card({ expYear: 29 }), "create", NOW).data.expYear, 2029);
  assert.equal(parseVaultInput(card({ expMonth: "04", expYear: "2029" }), "create", NOW).data.expMonth, 4);
  refused(() => parseVaultInput(card({ expMonth: 0 }), "create", NOW), /1 to 12/);
  refused(() => parseVaultInput(card({ expMonth: 13 }), "create", NOW), /1 to 12/);
  refused(() => parseVaultInput(card({ expMonth: 1.5 }), "create", NOW), /whole number/);
  refused(() => parseVaultInput(card({ expMonth: "x" }), "create", NOW), /whole number/);
  refused(() => parseVaultInput(card({ expMonth: undefined }), "create", NOW), /whole number/);
  refused(() => parseVaultInput(card({ expYear: 2024 }), "create", NOW), /not one a card has/);
  refused(() => parseVaultInput(card({ expYear: 2100 }), "create", NOW), /not one a card has/);
  assert.equal(parseVaultInput(card({ expYear: 2025 }), "create", NOW).data.expYear, 2025, "last year is allowed so an expired card can be kept and updated");
  assert.equal(parseVaultInput(card({ expYear: 2056 }), "create", NOW).data.expYear, 2056);
});

/* Contacts ---------------------------------------------------------------- */

test("a contact keeps its address, emails and phone numbers", () => {
  const draft = parseVaultInput(
    contact({ emails: ["b@example.com", "ada@example.com", "b@example.com"], phones: ["+44 20 7946 0958", "(555) 123-4567"], defaultShipping: true }),
    "create",
  );
  assert.deepEqual(draft.data.emails, ["b@example.com"], "the primary is not repeated and duplicates collapse");
  assert.deepEqual(draft.data.phones, ["+44 20 7946 0958", "(555) 123-4567"]);
  assert.equal(draft.data.defaultShipping, true);
  assert.equal((draft.data.address as { city: string }).city, "London");
  assert.deepEqual(draft.secrets, {});
});

test("a contact needs something to fill, and well-formed emails and phones", () => {
  refused(() => parseVaultInput({ kind: "contact", title: "Empty" }, "create"), /needs an email, a phone number or an address/);
  refused(() => parseVaultInput(contact({ email: "not-an-email" }), "create"), /not an email/);
  refused(() => parseVaultInput(contact({ emails: ["a@b"] }), "create"), /not an email/);
  refused(() => parseVaultInput(contact({ phones: ["call me"] }), "create"), /not a phone number/);
  refused(() => parseVaultInput(contact({ address: { phone: "abc" } }), "create"), /not a phone number/);
  refused(() => parseVaultInput(contact({ address: "1 Main St" }), "create"), /must be an object/);
  refused(() => parseVaultInput(contact({ emails: Array.from({ length: VAULT_LIMITS.emails + 1 }, (_, i) => `a${i}@example.com`) }), "create"), /at most 5/);
  assert.equal(parseVaultInput({ kind: "contact", title: "Phone only", phones: ["+1 555 0100"] }, "create").data.email, "");
  assert.equal(parseVaultInput({ kind: "contact", title: "Address only", address: { line1: "1 Main St" } }, "create").data.email, "");
  assert.equal(parseVaultInput(contact({ defaultShipping: "yes" }), "create").data.defaultShipping, false, "only true means true");
});

/* Views ------------------------------------------------------------------- */

function stored(over: Partial<StoredVaultItem> & Pick<StoredVaultItem, "kind" | "data">): StoredVaultItem {
  return { id: "v1", title: "T", notes: "", createdAt: 1, updatedAt: 2, secrets: {}, ...over };
}

test("a login's view says whether a password is saved, and carries none", () => {
  const item = stored({ kind: "login", data: { username: "ada", sites: ["github.com"] }, secrets: { password: "CIPHER" } });
  const view = viewOf(item);
  assert.deepEqual(view, { id: "v1", title: "T", notes: "", createdAt: 1, updatedAt: 2, kind: "login", username: "ada", sites: ["github.com"], hasPassword: true });
  assert.equal(JSON.stringify(view).includes("CIPHER"), false);
  assert.equal(viewOf({ ...item, secrets: {} }).kind === "login" && (viewOf({ ...item, secrets: {} }) as { hasPassword: boolean }).hasPassword, false);
});

test("a card's view has the brand, last four and expiry, never the number or code", () => {
  const item = stored({
    kind: "card",
    data: { brand: "visa", last4: "4242", expMonth: 4, expYear: 2029, holderName: "Ada", billingAddress: { line1: "1 Main St" } },
    secrets: { number: "CIPHER-N", securityCode: "CIPHER-C" },
  });
  const view = viewOf(item);
  assert.equal(view.kind, "card");
  if (view.kind !== "card") return;
  assert.deepEqual([view.brand, view.last4, view.expMonth, view.expYear, view.holderName, view.hasSecurityCode], ["visa", "4242", 4, 2029, "Ada", true]);
  assert.equal(view.billingAddress?.line1, "1 Main St");
  assert.equal(view.billingAddress?.city, "");
  assert.equal(JSON.stringify(view).includes("CIPHER"), false);
  const bare = viewOf({ ...item, data: { brand: "bogus" }, secrets: {} });
  assert.equal(bare.kind === "card" && bare.hasSecurityCode, false);
  assert.equal(bare.kind === "card" && bare.brand, "unknown");
  assert.equal(bare.kind === "card" && bare.billingAddress, null);
});

test("a contact's view is its address and ways to reach it", () => {
  const view = viewOf(stored({ kind: "contact", data: { address: { line1: "1 Main St", city: "London" }, defaultShipping: true, email: "a@b.co", emails: ["c@d.co", 5], phones: ["1"] } }));
  assert.equal(view.kind, "contact");
  if (view.kind !== "contact") return;
  assert.equal(view.address.city, "London");
  assert.equal(view.address.name, "");
  assert.deepEqual([view.defaultShipping, view.email, view.emails, view.phones], [true, "a@b.co", ["c@d.co"], ["1"]]);
});

test("what is read from disk is only trusted when it has the right shape", () => {
  const good = stored({ kind: "login", data: {} });
  assert.equal(isStoredVaultItem(good), true);
  for (const bad of [null, "x", {}, { ...good, id: "" }, { ...good, kind: "note" }, { ...good, title: 1 }, { ...good, data: null }, { ...good, secrets: null }, { ...good, createdAt: "1" }]) {
    assert.equal(isStoredVaultItem(bad), false);
  }
  assert.equal(isVaultGrant({ botId: "b", itemId: "i", host: "h", grantedAt: 1 }), true);
  for (const bad of [null, {}, { botId: "b", itemId: "i", host: "h" }, { botId: 1, itemId: "i", host: "h", grantedAt: 1 }]) assert.equal(isVaultGrant(bad), false);
});

/* Filling ----------------------------------------------------------------- */

const decrypt = (value: string): string | null => (value.startsWith("enc:") ? value.slice(4) : null);

test("a login fills its username and password", () => {
  const item = stored({ kind: "login", data: { username: "ada", sites: [] }, secrets: { password: "enc:s3cret" } });
  assert.equal(resolveVaultField(item, "username", decrypt), "ada");
  assert.equal(resolveVaultField(item, "password", decrypt), "s3cret");
  assert.equal(resolveVaultField(item, "number", decrypt), null, "not a login field");
  assert.equal(resolveVaultField({ ...item, secrets: { password: "garbled" } }, "password", decrypt), null, "an unreadable secret is null, never the cipher text");
  assert.equal(resolveVaultField({ ...item, secrets: {} }, "password", decrypt), null);
});

test("a card fills its number, code, holder, expiry and billing address", () => {
  const item = stored({
    kind: "card",
    data: { expMonth: 4, expYear: 2029, holderName: "Ada", billingAddress: { line1: "1 Main St", postalCode: "N1 9GU", country: "GB" } },
    secrets: { number: `enc:${VISA}`, securityCode: "enc:123" },
  });
  const f = (field: string) => resolveVaultField(item, field, decrypt);
  assert.equal(f("number"), VISA);
  assert.equal(f("securityCode"), "123");
  assert.equal(f("holderName"), "Ada");
  assert.equal(f("expiry"), "04/29");
  assert.equal(f("expMonth"), "04");
  assert.equal(f("expYear"), "2029");
  assert.equal(f("line1"), "1 Main St");
  assert.equal(f("postalCode"), "N1 9GU");
  assert.equal(f("country"), "GB");
  assert.equal(f("city"), null, "an empty field is null");
  assert.equal(f("password"), null);
  assert.equal(resolveVaultField({ ...item, data: {} }, "expiry", decrypt), null);
});

test("a contact fills its name, email, phone and address, falling back to the lists", () => {
  const item = stored({ kind: "contact", data: { address: { name: "Ada L", line1: "1 Main St", phone: "" }, email: "", emails: ["x@y.co"], phones: ["+1 555 0100"] } });
  const f = (field: string) => resolveVaultField(item, field, decrypt);
  assert.equal(f("name"), "Ada L");
  assert.equal(f("email"), "x@y.co");
  assert.equal(f("phone"), "+1 555 0100");
  assert.equal(f("line1"), "1 Main St");
  assert.equal(f("city"), null);
  const direct = stored({ kind: "contact", data: { address: { phone: "111" }, email: "a@b.co", phones: ["222"] } });
  assert.equal(resolveVaultField(direct, "phone", decrypt), "111");
  assert.equal(resolveVaultField(direct, "email", decrypt), "a@b.co");
});

test("each kind lists the fields it can fill, and only those are accepted", () => {
  assert.deepEqual(VAULT_FIELDS.login, ["username", "password"]);
  assert.equal(isVaultField("card", "number"), true);
  assert.equal(isVaultField("login", "number"), false);
  assert.equal(isVaultField("contact", "email"), true);
  assert.equal(isVaultField("contact", "password"), false);
  assert.equal(isVaultField("login", 5), false);
  assert.equal(isVaultField("login", "__proto__"), false);
});

/* Hiding secrets ---------------------------------------------------------- */

test("a card number is hidden with or without separators", () => {
  assert.deepEqual(secretForms("password", "pw"), ["pw"]);
  const forms = secretForms("number", VISA);
  for (const form of [VISA, "4242 4242 4242 4242", "4242-4242-4242-4242"]) assert.ok(forms.includes(form), form);
  const amex = secretForms("number", AMEX);
  for (const form of [AMEX, "3782 8224 6310 005", "3782 822463 10005", "3782-822463-10005"]) assert.ok(amex.includes(form), form);
});

test("a long secret is hidden wherever it appears, longest first", () => {
  const secrets = ["hunter2hunter2", "hunter2hunter2!extra"];
  assert.equal(redactSecrets(`textbox value="hunter2hunter2" and hunter2hunter2!extra`, secrets), `textbox value="${REDACTED}" and ${REDACTED}`);
  assert.equal(redactSecrets("nothing here", secrets), "nothing here");
  assert.equal(redactSecrets("", secrets), "");
  assert.equal(redactSecrets("hunter2hunter2", []), "hunter2hunter2");
  assert.equal(redactSecrets("a hunter2hunter2 b hunter2hunter2", secrets), `a ${REDACTED} b ${REDACTED}`);
});

test("a short secret is hidden only as a whole quoted string, so ordinary text survives", () => {
  assert.equal(redactSecrets(`textbox "Code" value="123"`, ["123"]), `textbox "Code" value="${REDACTED}"`);
  assert.equal(redactSecrets(`'123' and "123"`, ["123"]), `'${REDACTED}' and "${REDACTED}"`);
  assert.equal(redactSecrets("order 1234 has 123 items in 5123", ["123"]), "order 1234 has 123 items in 5123");
  assert.equal(redactSecrets("abcde", ["abcde"]), "abcde", "five characters is still short");
  assert.equal(redactSecrets("abcdef", ["abcdef"]), REDACTED, "six is hidden anywhere");
});

test("an empty secret is ignored and a repeated one is hidden once", () => {
  assert.equal(redactSecrets("keep me", [""]), "keep me");
  assert.equal(redactSecrets("a secret1 b", ["secret1", "secret1"]), `a ${REDACTED} b`);
});
