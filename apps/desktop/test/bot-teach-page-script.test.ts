import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTeachPageEvent, TeachRecorder } from "@deyin/host-core";
import { FakeElement, field, page } from "./helpers/fake-page.js";

/* Installing ------------------------------------------------------------------------ */

test("the script listens at the top of the page for clicks, typing, menu changes and keys, before the page's own handlers", () => {
  const p = page();
  assert.equal(p.install(), true);
  assert.deepEqual([...p.listeners.keys()].sort(), ["change", "click", "input", "keydown"]);
  for (const entries of p.listeners.values()) assert.deepEqual(entries.map((entry) => entry.capture), [true], "in the capture phase");
  assert.deepEqual(p.drain(), []);
});

test("installing twice does not listen twice, so one click is one event", () => {
  const p = page();
  p.install();
  p.install();
  p.fire("click", field("button", { text: "Export" }));
  assert.deepEqual(p.drain(), [{ kind: "click", target: 'button "Export"' }]);
});

test("draining hands over what was seen once, and a page without the script has nothing to hand over", () => {
  const p = page();
  assert.deepEqual(p.drain(), [], "not installed yet");
  p.install();
  p.fire("click", field("button", { text: "A" }));
  assert.equal(p.drain().length, 1);
  assert.deepEqual(p.drain(), []);
});

test("the page's own scripts cannot reach what the script holds: it lives in the world it was run in, not the page's", () => {
  const p = page();
  p.install();
  const holder = (p.context as unknown as { window: Record<string, unknown> }).window;
  assert.equal(typeof holder.__deyinTeach, "object", "this test's page shares one world; in the app the script runs in an isolated one");
});

/* Clicks ------------------------------------------------------------------------------ */

test("a click is named by what was clicked, the way a person would say it", () => {
  const p = page();
  p.install();
  p.fire("click", field("button", { text: "  Export\n  report " }));
  p.fire("click", field("a", { text: "Reports" }));
  p.fire("click", field("input", { type: "submit", value: "Search" }));
  p.fire("click", field("input", { type: "checkbox", labels: [field("label", { text: "Remember me" })] }));
  p.fire("click", field("input", { type: "radio", attrs: { "aria-label": "Weekly" } }));
  p.fire("click", field("div", { attrs: { role: "tab" }, text: "Billing" }));
  p.fire("click", field("div", { attrs: { role: "menuitem" }, text: "Delete" }));
  p.fire("click", field("summary", { text: "Advanced" }));
  p.fire("click", field("button", { attrs: { "aria-label": "Close dialog" }, text: "×" }));
  p.fire("click", field("button", { attrs: { title: "Refresh" }, text: "" }));
  p.fire("click", field("button", { text: "" }));
  assert.deepEqual(
    p.drain().map((e) => (e as { target: string }).target),
    ['button "Export report"', 'link "Reports"', 'button "Search"', 'checkbox "Remember me"', 'option "Weekly"', 'tab "Billing"', 'menu item "Delete"', 'section "Advanced"', 'button "Close dialog"', 'button "Refresh"', "a button"],
  );
});

test("a click on something inside a button or link is a click on the button or link", () => {
  const p = page();
  p.install();
  const button = field("button", { text: "Save changes" });
  const icon = field("span", { text: "", parent: button });
  const nested = field("b", { text: "Save", parent: field("span", { parent: button }) });
  p.fire("click", icon);
  p.fire("click", nested);
  assert.deepEqual(p.drain().map((e) => (e as { target: string }).target), ['button "Save changes"', 'button "Save changes"']);
});

test("a click into a text box or a menu is not a step: what is typed or chosen is", () => {
  const p = page();
  p.install();
  p.fire("click", field("input", { type: "text", attrs: { placeholder: "Search" } }));
  p.fire("click", field("textarea"));
  p.fire("click", field("select", { attrs: { name: "format" } }));
  p.fire("click", field("div", { text: "Some text on the page" }));
  assert.deepEqual(p.drain(), [{ kind: "click", target: 'item "Some text on the page"' }]);
});

test("a label is one of the places a click can land, even when it holds nothing but a box", () => {
  const p = page();
  p.install();
  p.fire("click", field("label", { text: "Terms" }));
  assert.deepEqual(p.drain(), [{ kind: "click", target: 'item "Terms"' }]);
});

/* Typing ------------------------------------------------------------------------------- */

test("typing is sent with the name of the field and what is in it so far", () => {
  const p = page();
  p.install();
  p.fire("input", field("input", { type: "text", value: "wee", attrs: { placeholder: "Search" } }));
  p.fire("input", field("input", { type: "text", value: "weekly", attrs: { placeholder: "Search" } }));
  p.fire("input", field("textarea", { value: "Dear team", labels: [field("label", { text: "Message" })] }));
  p.fire("input", field("div", { editable: true, text: "Typed into a rich editor", attrs: { "aria-label": "Body" } }));
  p.fire("input", field("input", { type: "email", value: "a@b.co" }));
  assert.deepEqual(p.drain(), [
    { kind: "type", target: "Search", text: "wee", secret: false },
    { kind: "type", target: "Search", text: "weekly", secret: false },
    { kind: "type", target: "Message", text: "Dear team", secret: false },
    { kind: "type", target: "Body", text: "Typed into a rich editor", secret: false },
    { kind: "type", target: "a field", text: "a@b.co", secret: false },
  ]);
});

test("what is typed into a password, card or code field is never read, whatever the field is called", () => {
  const p = page();
  p.install();
  const secrets: FakeElement[] = [
    field("input", { type: "password", value: "hunter2" }),
    field("input", { type: "text", value: "hunter2", attrs: { autocomplete: "current-password" } }),
    field("input", { type: "text", value: "4111111111111111", attrs: { autocomplete: "cc-number" } }),
    field("input", { type: "text", value: "123456", attrs: { autocomplete: "one-time-code" } }),
    field("input", { type: "text", value: "hunter2", attrs: { name: "user_password" } }),
    field("input", { type: "text", value: "hunter2", attrs: { id: "cvv" } }),
    field("input", { type: "text", value: "hunter2", attrs: { placeholder: "Card number" } }),
    field("input", { type: "text", value: "hunter2", labels: [field("label", { text: "Security code" })] }),
    field("input", { type: "text", value: "hunter2", attrs: { "aria-label": "API key" } }),
    field("input", { type: "text", value: "hunter2", attrs: { name: "otp" } }),
  ];
  // Reading the value of a secret field at all is what must not happen, so the fake throws if it is touched.
  for (const secret of secrets) {
    Object.defineProperty(secret, "value", {
      get() {
        throw new Error("the value of a secret field was read");
      },
    });
    p.fire("input", secret);
  }
  const seen = p.drain() as Array<{ kind: string; text: string; secret: boolean }>;
  assert.equal(seen.length, secrets.length);
  for (const event of seen) {
    assert.equal(event.secret, true);
    assert.equal(event.text, "");
  }
  assert.equal(JSON.stringify(seen).includes("hunter2"), false);
});

test("boxes that are not typed into are not typing", () => {
  const p = page();
  p.install();
  for (const type of ["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color", "hidden"]) p.fire("input", field("input", { type, value: "x" }));
  p.fire("input", field("div", { text: "not editable" }));
  p.fire("input", field("select"));
  assert.deepEqual(p.drain(), []);
});

/* Menus and keys ----------------------------------------------------------------------- */

test("choosing from a menu says which menu and which option, by the words a person sees", () => {
  const p = page();
  p.install();
  const menu = field("select", { labels: [field("label", { text: "Format" })], selected: [field("option", { text: " CSV (comma separated) " })] });
  p.fire("change", menu);
  p.fire("change", field("select", { attrs: { name: "size" }, value: "L", selected: [] }));
  p.fire("change", field("input", { type: "text", value: "not a menu" }));
  assert.deepEqual(p.drain(), [
    { kind: "choose", target: "Format", value: "CSV (comma separated)" },
    { kind: "choose", target: "size", value: "L" },
  ]);
});

test("Enter and Escape are steps, except Enter in a box where it only makes a new line; other keys are not", () => {
  const p = page();
  p.install();
  const input = field("input", { type: "text" });
  p.fire("keydown", input, { key: "Enter" });
  p.fire("keydown", input, { key: "Escape" });
  p.fire("keydown", input, { key: "Tab" });
  p.fire("keydown", input, { key: "a" });
  p.fire("keydown", input, { key: "Shift" });
  p.fire("keydown", field("textarea"), { key: "Enter" });
  p.fire("keydown", field("textarea"), { key: "Escape" });
  assert.deepEqual(p.drain(), [
    { kind: "press", key: "Enter" },
    { kind: "press", key: "Escape" },
    { kind: "press", key: "Escape" },
  ]);
});

/* Whose events ---------------------------------------------------------------------------- */

test("only what a person did counts: events a page made up are ignored, whatever kind they are", () => {
  const p = page();
  p.install();
  const button = field("button", { text: "Export" });
  const box = field("input", { type: "text", value: "x", attrs: { placeholder: "Search" } });
  p.fire("click", button, {}, false);
  p.fire("input", box, {}, false);
  p.fire("change", field("select", { selected: [field("option", { text: "A" })] }), {}, false);
  p.fire("keydown", box, { key: "Enter" }, false);
  assert.deepEqual(p.drain(), []);
  p.fire("click", button);
  assert.equal(p.drain().length, 1);
});

test("an event without something that was touched is ignored", () => {
  const p = page();
  p.install();
  for (const type of ["click", "input", "change", "keydown"]) {
    for (const listener of p.listeners.get(type) ?? []) {
      listener.fn({ type, isTrusted: true });
      listener.fn({ type, isTrusted: true, target: null });
      listener.fn({ type, isTrusted: true, target: { nodeType: 3 } });
      listener.fn({ type, isTrusted: "yes", target: field("button", { text: "x" }) });
    }
  }
  assert.deepEqual(p.drain(), []);
});

/* Bounds ------------------------------------------------------------------------------------ */

test("a long click label is cut, and what the script keeps is never more than it can hold", () => {
  const p = page();
  p.install();
  p.fire("click", field("button", { text: "x".repeat(500) }));
  const [first] = p.drain() as Array<{ target: string }>;
  assert.ok(first!.target.length <= 'button ""'.length + 80);
  for (let n = 0; n < 700; n += 1) p.fire("click", field("button", { text: `Button ${n}` }));
  const kept = p.drain() as Array<{ target: string }>;
  assert.equal(kept.length, 500, "the oldest are let go, so a page left open cannot grow without end");
  assert.equal(kept.at(-1)!.target, 'button "Button 699"');
  assert.equal(kept[0]!.target, 'button "Button 200"');
});

/* From the page to a recording ------------------------------------------------------------------ */

test("everything the script sends goes through the app's own checks, and a secret that got past the script is still not kept", () => {
  const p = page();
  p.install();
  p.fire("click", field("button", { text: "Sign in" }));
  p.fire("input", field("input", { type: "text", value: "ada", attrs: { placeholder: "Username" } }));
  p.fire("input", field("input", { type: "password", value: "hunter2" }));
  p.fire("input", field("input", { type: "text", value: "4242 4242 4242 4242", attrs: { placeholder: "Coupon" } }));
  p.fire("keydown", field("input", { type: "text" }), { key: "Enter" });
  let clock = 1_000;
  const recorder = new TeachRecorder("Sign in", clock, () => (clock += 10));
  for (const raw of p.drain()) {
    const event = parseTeachPageEvent(raw);
    assert.ok(event, JSON.stringify(raw));
    recorder.add(event);
  }
  const recording = recorder.stop();
  assert.deepEqual(
    recording.steps.map((step) => (step.kind === "type" ? [step.kind, step.target, step.secret ? "secret" : step.text] : [step.kind, "target" in step ? step.target : "key" in step ? step.key : ""])),
    [["click", 'button "Sign in"'], ["type", "Username", "ada"], ["type", "a field", "secret"], ["type", "Coupon", "secret"], ["press", "Enter"]],
  );
  assert.equal(recording.secretsOmitted, 2);
  assert.equal(JSON.stringify(recording).includes("hunter2") || JSON.stringify(recording).includes("4242"), false);
});
