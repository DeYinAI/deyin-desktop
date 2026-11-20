import assert from "node:assert/strict";
import test from "node:test";
import { migrateSettings } from "../src/defaults.js";
import {
  ONE_PASSWORD_LIMITS,
  isOnePasswordField,
  isOnePasswordId,
  parseOnePasswordCredential,
  parseOnePasswordLogins,
} from "../src/shared.js";

const ID = "abcdefghijklmnopqrstuvwxyz";

const listing = (items: unknown): string => JSON.stringify(items);

test("a login in the list becomes a title, a user name and the hosts it is saved for, with no secret", () => {
  const [login] = parseOnePasswordLogins(
    listing([
      {
        id: ID,
        title: "  GitHub  ",
        category: "LOGIN",
        additional_information: "octocat",
        urls: [{ label: "website", primary: true, href: "https://github.com/login" }, { href: "https://gist.github.com" }],
      },
    ]),
  );
  assert.deepEqual(login, { id: ID, title: "GitHub", username: "octocat", sites: ["github.com", "gist.github.com"] });
});

test("only logins are kept, and an entry without a usable id or title is skipped", () => {
  const logins = parseOnePasswordLogins(
    listing([
      { id: ID, title: "Real", category: "LOGIN" },
      { id: "bbbbbbbbbbbbbbbb", title: "A card", category: "CREDIT_CARD" },
      { id: "--flag", title: "Bad id", category: "LOGIN" },
      { id: "cccccccccccccccc", title: "   ", category: "LOGIN" },
      { title: "No id", category: "LOGIN" },
      "nonsense",
      null,
    ]),
  );
  assert.deepEqual(logins.map((login) => login.title), ["Real"]);
});

test("a missing category is taken as a login, because the list was asked for logins", () => {
  assert.equal(parseOnePasswordLogins(listing([{ id: ID, title: "No category" }])).length, 1);
});

test("sites: only addresses a login could be used on, each once, and no more than the limit", () => {
  const urls = [
    { href: "https://example.com/a" },
    { href: "https://example.com/b" },
    { href: "not a url" },
    { href: "https://co.uk" },
    ...Array.from({ length: 20 }, (_, index) => ({ href: `https://site${index}.example.org` })),
  ];
  const [login] = parseOnePasswordLogins(listing([{ id: ID, title: "Many", urls }]));
  assert.equal(login?.sites[0], "example.com");
  assert.equal(login?.sites.filter((site) => site === "example.com").length, 1);
  assert.ok(!login?.sites.includes("co.uk"), "a shared suffix cannot be a site");
  assert.equal(login?.sites.length, 8);
  assert.equal(ONE_PASSWORD_LIMITS.sites, 8);
});

test("a title or user name is kept to a sensible length, on one line", () => {
  const [login] = parseOnePasswordLogins(listing([{ id: ID, title: `${"a".repeat(500)}\nsecond line`, additional_information: "x\n\ny".repeat(100) }]));
  assert.equal(login?.title.length, 120);
  assert.equal(ONE_PASSWORD_LIMITS.text, 120);
  assert.ok(!/\n/.test(login?.username ?? ""));
});

test("output that is not a list gives an empty list rather than an error", () => {
  for (const out of ["", "not json", "{}", "null", '"text"', "[1,2]"]) assert.deepEqual(parseOnePasswordLogins(out), [], out);
});

test("the credential is the field marked as the user name and the one marked as the password", () => {
  const out = JSON.stringify({
    id: ID,
    fields: [
      { id: "notesPlain", purpose: "NOTES", value: "a note" },
      { id: "username", purpose: "USERNAME", label: "username", value: "octocat" },
      { id: "password", purpose: "PASSWORD", label: "password", type: "CONCEALED", value: "hunter2" },
      { id: "extra", label: "password", value: "not this one" },
    ],
  });
  assert.deepEqual(parseOnePasswordCredential(out), { username: "octocat", password: "hunter2" });
});

test("a login with no password, an empty one, or a value that is not text has none", () => {
  const out = JSON.stringify({ fields: [{ purpose: "USERNAME", value: "me" }, { purpose: "PASSWORD", value: "" }] });
  assert.deepEqual(parseOnePasswordCredential(out), { username: "me", password: null });
  assert.deepEqual(parseOnePasswordCredential(JSON.stringify({ fields: [{ purpose: "PASSWORD", value: 12345 }] })), { username: null, password: null });
  for (const bad of ["", "nope", "[]", "{}", JSON.stringify({ fields: "x" })]) {
    assert.deepEqual(parseOnePasswordCredential(bad), { username: null, password: null }, bad);
  }
});

test("ids are letters and digits only, so one can never be taken for an option", () => {
  assert.equal(isOnePasswordId(ID), true);
  for (const bad of ["", "short", "--vault", "-a-b-c-d-e-f", "has space 123456", "a".repeat(65), 12345678, null, undefined, "abc;rm -rf /"]) {
    assert.equal(isOnePasswordId(bad), false, String(bad));
  }
});

test("an id is eight to sixty-four letters or digits, exactly", () => {
  assert.equal(isOnePasswordId("a".repeat(8)), true);
  assert.equal(isOnePasswordId("a".repeat(64)), true);
  assert.equal(isOnePasswordId("a".repeat(7)), false);
  assert.equal(isOnePasswordId("a".repeat(65)), false);
  assert.equal(isOnePasswordId("0123456789ABCxyz"), true, "digits and both cases of letters");
});

test("only the user name and the password can be filled", () => {
  assert.equal(isOnePasswordField("username"), true);
  assert.equal(isOnePasswordField("password"), true);
  for (const bad of ["totp", "notes", "Password", "", 1, undefined]) assert.equal(isOnePasswordField(bad), false, String(bad));
});

test("the setting is off by default, and anything but a boolean puts it back off", () => {
  assert.equal(migrateSettings({}).vaultOnePassword, false);
  assert.equal(migrateSettings({ vaultOnePassword: true }).vaultOnePassword, true);
  assert.equal(migrateSettings({ vaultOnePassword: "yes" }).vaultOnePassword, false);
});
