import assert from "node:assert/strict";
import { test } from "node:test";
import { SECURE_FORM_LIMITS, cleanSecureFormAnswer, parseSecureForm, type SecureFormRequest } from "../src/bots/secure-form.js";

const HOST = "example.com";
const ok = (over: Record<string, unknown> = {}) => ({
  title: "Sign in to Example",
  reason: "Your saved login did not work.",
  fields: [
    { id: "user", label: "Username", ref: "e3" },
    { id: "pw", label: "Password", secret: true, ref: "e4" },
  ],
  ...over,
});
const refused = (args: Record<string, unknown>, pattern: RegExp): void => assert.throws(() => parseSecureForm(args, HOST), pattern);

test("a request is shown as asked, with where it will be typed, and each field knows its page element", () => {
  const { request, targets } = parseSecureForm(ok(), HOST);
  assert.deepEqual(request, {
    title: "Sign in to Example",
    reason: "Your saved login did not work.",
    host: HOST,
    fields: [
      { id: "user", label: "Username", secret: false },
      { id: "pw", label: "Password", secret: true },
    ],
  });
  assert.deepEqual(targets, { user: "e3", pw: "e4" });
  assert.equal(parseSecureForm(ok({ reason: undefined }), HOST).request.reason, "");
});

test("only an explicit true makes a field secret, and text is tidied", () => {
  const { request } = parseSecureForm(ok({ title: " Sign\u0007 in\n", fields: [{ id: "a", label: " Code\t", ref: "e1", secret: "yes" }] }), HOST);
  assert.equal(request.title, "Sign in");
  assert.equal(request.fields[0]?.label, "Code");
  assert.equal(request.fields[0]?.secret, false);
});

test("a request needs a title and at least one well-formed field", () => {
  refused(ok({ title: "" }), /title is required/);
  refused(ok({ title: 5 }), /title must be text/);
  refused(ok({ fields: undefined }), /at least one field/);
  refused(ok({ fields: [] }), /at least one field/);
  refused(ok({ fields: "x" }), /at least one field/);
  refused(ok({ fields: ["x"] }), /object with id, label and ref/);
  refused(ok({ fields: [null] }), /object with id, label and ref/);
  refused(ok({ fields: [[]] }), /object with id, label and ref/);
  refused(ok({ fields: [{ id: "a b", label: "A", ref: "e1" }] }), /field id is 1 to 40/);
  refused(ok({ fields: [{ id: "", label: "A", ref: "e1" }] }), /field id is 1 to 40/);
  refused(ok({ fields: [{ id: "x".repeat(41), label: "A", ref: "e1" }] }), /field id is 1 to 40/);
  refused(ok({ fields: [{ label: "A", ref: "e1" }] }), /field id is 1 to 40/);
  refused(ok({ fields: [{ id: "a", label: "", ref: "e1" }] }), /label of field "a" is required/);
  refused(ok({ fields: [{ id: "a", label: "x".repeat(SECURE_FORM_LIMITS.label + 1), ref: "e1" }] }), /too long/);
  refused(ok({ title: "x".repeat(SECURE_FORM_LIMITS.title + 1) }), /title is too long/);
  refused(ok({ reason: "x".repeat(SECURE_FORM_LIMITS.reason + 1) }), /reason is too long/);
});

test("a field's page element must be a snapshot ref", () => {
  for (const ref of ["12", "e", "e1x", "#password", "e-1", "", undefined, 5]) {
    refused(ok({ fields: [{ id: "a", label: "A", ref }] }), /needs a ref from browser_snapshot/);
  }
});

test("ids are unique and cannot be names that break an object", () => {
  refused(ok({ fields: [{ id: "a", label: "A", ref: "e1" }, { id: "a", label: "B", ref: "e2" }] }), /used twice/);
  for (const id of ["__proto__", "constructor", "prototype"]) {
    refused(ok({ fields: [{ id, label: "A", ref: "e1" }] }), /field id is 1 to 40/);
  }
});

test("a form has a limited number of fields", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, label: `F${i}`, ref: `e${i}` }));
  assert.equal(parseSecureForm(ok({ fields: many(SECURE_FORM_LIMITS.fields) }), HOST).request.fields.length, SECURE_FORM_LIMITS.fields);
  refused(ok({ fields: many(SECURE_FORM_LIMITS.fields + 1) }), /at most 8 fields/);
});

const request: SecureFormRequest = parseSecureForm(ok(), HOST).request;

test("an answer keeps only the asked-for text fields that have a value", () => {
  assert.deepEqual(cleanSecureFormAnswer(request, { user: "ada", pw: "s3cret", extra: "no" }), { user: "ada", pw: "s3cret" });
  assert.deepEqual(cleanSecureFormAnswer(request, { user: "ada", pw: "" }), { user: "ada" });
  assert.deepEqual(cleanSecureFormAnswer(request, { user: 5, pw: ["x"] , }), null);
  assert.deepEqual(cleanSecureFormAnswer(request, { pw: " leading and trailing " }), { pw: " leading and trailing " }, "a typed value is not trimmed");
});

test("a cancelled, empty or malformed answer is null", () => {
  for (const bad of [null, undefined, "x", 3, [], {}, { extra: "x" }, { user: "" }]) assert.equal(cleanSecureFormAnswer(request, bad), null);
});

test("a list is not an answer, even when its positions look like field ids", () => {
  const numbered = parseSecureForm(ok({ fields: [{ id: "0", label: "First", ref: "e1" }] }), HOST).request;
  assert.equal(cleanSecureFormAnswer(numbered, ["typed"]), null);
  assert.deepEqual(cleanSecureFormAnswer(numbered, { 0: "typed" }), { "0": "typed" });
});

test("an oversized value is dropped, and inherited keys are never read", () => {
  assert.deepEqual(cleanSecureFormAnswer(request, { user: "ok", pw: "x".repeat(SECURE_FORM_LIMITS.value + 1) }), { user: "ok" });
  assert.equal(cleanSecureFormAnswer(request, { pw: "x".repeat(SECURE_FORM_LIMITS.value) })?.pw?.length, SECURE_FORM_LIMITS.value);
  const inherited = Object.create({ user: "from the prototype" }) as Record<string, unknown>;
  assert.equal(cleanSecureFormAnswer(request, inherited), null);
});
