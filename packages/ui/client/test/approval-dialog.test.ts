import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalDialog } from "../src/components/ApprovalDialog.js";

const noop = () => undefined;
const render = (props: Partial<Parameters<typeof ApprovalDialog>[0]> = {}) =>
  renderToStaticMarkup(createElement(ApprovalDialog, { toolName: "write", summary: "Write plan.md", onDecision: noop, ...props }));

test("a plain approval keeps its session-only wording and shows no reason", () => {
  const html = render();
  assert.match(html, /Allow for session/);
  assert.doesNotMatch(html, /Always allow/);
  assert.doesNotMatch(html, /approval-inline__reason/);
  assert.match(html, /Write plan\.md/);
});

test("a Bot's approval says why it asks and that always-allow is kept", () => {
  const html = render({ reason: "This can change things, so it needs your approval: Write plan.md.", saved: true });
  assert.match(html, /Always allow/);
  assert.doesNotMatch(html, /Allow for session/);
  assert.match(html, /approval-inline__reason/);
  assert.match(html, /needs your approval/);
});

test("the reason is text: markup in it is escaped, not run", () => {
  const html = render({ reason: "<img src=x onerror=alert(1)>" });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("all three answers are offered either way", () => {
  for (const saved of [false, true]) {
    const html = render({ saved });
    for (const label of ["Deny", "Allow once"]) assert.match(html, new RegExp(label));
    assert.equal((html.match(/<button/g) ?? []).length, 3);
  }
});

test("more waiting is shown", () => {
  assert.match(render({ pendingCount: 3 }), /2 more waiting/);
  assert.doesNotMatch(render({ pendingCount: 1 }), /more waiting/);
});
