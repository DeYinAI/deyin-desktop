import assert from "node:assert/strict";
import test from "node:test";

if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
}
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanSecureFormAnswer, missingTranslations, type SecureFormRequest } from "@deyin/host-core/shared";
import { SecureFormDialog } from "../src/bots/SecureFormDialog.js";
import { __testDispatch, __testResetAgentStore, agentStateStore, type AgentSideEffect } from "../src/hooks/useAgentState.js";
import { canSubmitSecureForm, emptySecureFormValues, secureFormAnswer } from "../src/bots/secureForm.js";

const noop = () => undefined;

const request = (over: Partial<SecureFormRequest> = {}): SecureFormRequest => ({
  title: "Sign in to Acme",
  reason: "Acme asked for a code it sent to your phone.",
  host: "acme.example.com",
  fields: [
    { id: "code", label: "One-time code", secret: false },
    { id: "pw", label: "Password", secret: true },
  ],
  ...over,
});

const render = (req: SecureFormRequest = request()): string => renderToStaticMarkup(createElement(SecureFormDialog, { request: req, onSubmit: noop, onCancel: noop }));

test("a form starts with an empty value for every field it asks for", () => {
  assert.deepEqual(emptySecureFormValues(request()), { code: "", pw: "" });
  assert.deepEqual(emptySecureFormValues(request({ fields: [] })), {});
});

test("the answer is only the fields something was typed into, exactly as typed", () => {
  const req = request();
  assert.deepEqual(secureFormAnswer(req, { code: "123456", pw: "" }), { code: "123456" });
  assert.deepEqual(secureFormAnswer(req, { code: "", pw: " a b " }), { pw: " a b " }, "spaces in a password are part of it");
  assert.deepEqual(secureFormAnswer(req, { code: "1", pw: "2" }), { code: "1", pw: "2" });
});

test("nothing typed is not an answer, and a value for a field that was not asked for is dropped", () => {
  const req = request();
  assert.equal(secureFormAnswer(req, { code: "", pw: "" }), null);
  assert.equal(secureFormAnswer(req, {}), null);
  assert.deepEqual(secureFormAnswer(req, { code: "1", other: "x" }), { code: "1" });
  assert.equal(secureFormAnswer(req, { other: "x" }), null);
});

test("Fill in is available once anything is typed", () => {
  const req = request();
  assert.equal(canSubmitSecureForm(req, emptySecureFormValues(req)), false);
  assert.equal(canSubmitSecureForm(req, { code: "", pw: "x" }), true);
});

test("what the form sends is what the host keeps", () => {
  const req = request();
  for (const values of [{ code: "123456", pw: "" }, { code: "", pw: "pw" }, { code: "a", pw: "b" }]) {
    assert.deepEqual(secureFormAnswer(req, values), cleanSecureFormAnswer(req, values));
  }
  assert.equal(secureFormAnswer(req, { code: "", pw: "" }), cleanSecureFormAnswer(req, { code: "", pw: "" }));
});

test("the card names the form, says why, and says where it goes and that the Bot never sees it", () => {
  const html = render();
  assert.match(html, /aria-label="Sign in to Acme"/);
  assert.match(html, /secure-form__kicker">Secure form</);
  assert.match(html, /inline-card__title">Sign in to Acme</);
  assert.match(html, /Acme asked for a code it sent to your phone\./);
  assert.match(html, /What you type goes straight into acme\.example\.com\. The Bot never sees it and it is not saved\./);
  assert.doesNotMatch(render(request({ reason: "" })), /Acme asked/);
});

test("each field has a label, only a secret one is masked, and none lets the browser remember it", () => {
  const html = render();
  assert.match(html, /<label class="field__label" for="secure-form-code">One-time code<\/label>/);
  assert.match(html, /<label class="field__label" for="secure-form-pw">Password<\/label>/);
  const code = /<input id="secure-form-code"[^>]*>/.exec(html)?.[0] ?? "";
  const pw = /<input id="secure-form-pw"[^>]*>/.exec(html)?.[0] ?? "";
  assert.match(code, /type="text"/);
  assert.match(code, /autoComplete="off"/);
  assert.match(pw, /type="password"/);
  assert.match(pw, /autoComplete="new-password"/);
  assert.match(code + pw, /value=""/);
});

test("Fill in waits for something to be typed, and Cancel is always there", () => {
  const html = render();
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Fill in<\/button>/);
  assert.match(html, /<button type="button"[^>]*>Cancel<\/button>/);
  assert.doesNotMatch(/<button type="button"[^>]*>Cancel<\/button>/.exec(html)?.[0] ?? "", /disabled/);
});

test("every Secure Form string has text in every language", () => {
  for (const locale of ["zh", "de"] as const) {
    assert.deepEqual(missingTranslations(locale).filter((key) => key.startsWith("bot.secureForm.")), [], locale);
  }
});

test("a Bot's Secure Form request reaches the app tied to its thread", () => {
  __testResetAgentStore();
  const effects: AgentSideEffect[] = [];
  const stop = agentStateStore.onSideEffect((effect) => effects.push(effect));
  try {
    agentStateStore.startRun("t1", "agent");
    const form = request();
    __testDispatch({ threadId: "t1", event: { type: "secure-form-request", requestId: "r1", form } });
    assert.deepEqual(effects, [{ type: "secure-form-request", threadId: "t1", requestId: "r1", form }]);
  } finally {
    stop();
  }
});
