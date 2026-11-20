import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_PERMISSIONS, PERMISSION_LIMITS, updatePermissions, type BotApprovalMode, type BotPermissionSettings } from "@deyin/host-core/shared";
import { BotPermissionsPanel, type PermissionsState } from "../src/bots/BotPermissions.js";
import { emptyPermissionForm, type PermissionForm } from "../src/bots/botPermissions.js";

const noop = () => undefined;

interface Over {
  mode?: BotApprovalMode;
  state?: PermissionsState;
  busy?: boolean;
  error?: string | null;
  drafts?: { allowInstructions: string; blockInstructions: string };
  form?: PermissionForm;
}

function render(over: Over = {}): string {
  return renderToStaticMarkup(
    createElement(BotPermissionsPanel, {
      mode: over.mode ?? "auto_review",
      state: over.state ?? { status: "ready", settings: EMPTY_PERMISSIONS },
      busy: over.busy ?? false,
      error: over.error ?? null,
      drafts: over.drafts ?? { allowInstructions: "", blockInstructions: "" },
      form: over.form ?? emptyPermissionForm(),
      onMode: noop,
      onReviewEnabled: noop,
      onDraft: noop,
      onAddRule: noop,
      onRemoveRule: noop,
      onRowPermission: noop,
      onResetRow: noop,
      onForm: noop,
      onAddPermission: noop,
    }),
  );
}

const ready = (settings: BotPermissionSettings): PermissionsState => ({ status: "ready", settings });
const configured = (): BotPermissionSettings => {
  let settings = updatePermissions(EMPTY_PERMISSIONS, { autoReview: { enabled: true, allowInstructions: ["Reply to my team"], blockInstructions: ["Never email outside the company", "Never delete files"] } });
  settings = updatePermissions(settings, { tool: { scope: "gmail", tool: "send_email", permission: "needs_approval" } });
  settings = updatePermissions(settings, { defaults: { scope: "gmail", writes: "blocked" } });
  return settings;
};

test("the three modes are radios in order, and only the Bot's own is checked", () => {
  const html = render({ mode: "read_only" });
  const radios = [...html.matchAll(/<input type="radio"[^>]*>/g)].map((m) => m[0]);
  assert.equal(radios.length, 3);
  assert.deepEqual(radios.map((r) => /value="([^"]+)"/.exec(r)?.[1]), ["auto_review", "read_only", "run_everything"]);
  assert.deepEqual(radios.map((r) => r.includes("checked")), [false, true, false]);
  assert.match(html, /<strong>Auto Review<\/strong>/);
  assert.match(html, /Reads go ahead\. Nothing that changes things is ever done\./);
});

test("while loading or after a failure there are modes but no rules or tool list", () => {
  const loading = render({ state: { status: "loading" } });
  assert.match(loading, /role="status">Loading permissions…/);
  assert.doesNotMatch(loading, /bot-permissions__review|bot-permissions__tools/);
  assert.match(loading, /type="radio"/);
  const failed = render({ state: { status: "error", error: "ipc closed" } });
  assert.match(failed, /role="alert">Couldn&#x27;t load permissions\. ipc closed/);
  assert.doesNotMatch(failed, /bot-permissions__review|bot-permissions__tools/);
});

test("the rules show in their lists, each with Remove, and an empty list says so", () => {
  const html = render({ state: ready(configured()) });
  assert.match(html, /bot-permission__name">Reply to my team</);
  assert.match(html, /bot-permission__name">Never email outside the company</);
  assert.match(html, /aria-label="Remove: Never delete files"/);
  assert.equal([...html.matchAll(/aria-label="Remove: /g)].length, 3);
  const empty = render();
  assert.equal([...empty.matchAll(/No rules yet\./g)].length, 2);
  assert.doesNotMatch(empty, /aria-label="Remove: /);
});

test("the review switch reflects whether the rules are applied", () => {
  const on = render({ state: ready(configured()) });
  assert.match(on, /role="switch" aria-label="Apply these rules" aria-checked="true"/);
  const off = render({ state: ready(updatePermissions(configured(), { autoReview: { enabled: false } })) });
  assert.match(off, /role="switch" aria-label="Apply these rules" aria-checked="false"/);
  assert.match(render(), /aria-checked="true"/, "rules apply unless turned off");
});

test("each set permission is a row with its value selected, in order, and Reset", () => {
  const html = render({ state: ready(configured()) });
  const names = [...html.matchAll(/<span class="bot-permission__name">(gmail[^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(names, ["gmail · all changes", "gmail · send_email"]);
  assert.match(html, /<select class="input bot-permission__select" aria-label="gmail · all changes"[^>]*>(?:(?!<\/select>).)*<option value="blocked" selected="">Blocked<\/option>/);
  assert.match(html, /aria-label="gmail · send_email"[^>]*>(?:(?!<\/select>).)*<option value="needs_approval" selected="">Ask first<\/option>/);
  assert.equal([...html.matchAll(/>Reset</g)].length, 2);
  assert.doesNotMatch(html, /No tool permissions set\./);
  assert.match(render(), /No tool permissions set\./);
});

test("the add form asks for a tool name only when it applies to one tool", () => {
  const one = render();
  assert.match(one, /id="bot-permission-tool"/);
  assert.match(one, /id="bot-permission-group"[^>]*value="local"/);
  const all = render({ form: { ...emptyPermissionForm(), kind: "reads" } });
  assert.doesNotMatch(all, /id="bot-permission-tool"/);
  assert.doesNotMatch(render({ form: { ...emptyPermissionForm(), kind: "writes" } }), /id="bot-permission-tool"/);
  assert.match(one, /placeholder="local, or an MCP server&#x27;s name"/);
  assert.match(one, /placeholder="e\.g\. send_email"/);
  assert.match(one, /<label class="field__label" for="bot-permission-value">Set to<\/label>/);
});

test("the add buttons stay off until there is something to add", () => {
  const html = render();
  assert.match(html, /<button type="submit" class="btn btn--outline" disabled="" title="Name the tool\.">Add permission<\/button>/);
  assert.equal([...html.matchAll(/<button type="submit" class="btn btn--outline" disabled="">Add<\/button>/g)].length, 2);
  const typed = render({
    drafts: { allowInstructions: "Reply to my team", blockInstructions: "" },
    form: { ...emptyPermissionForm(), tool: "bash" },
  });
  assert.match(typed, /<button type="submit" class="btn btn--outline">Add permission<\/button>/);
  assert.equal([...typed.matchAll(/<button type="submit" class="btn btn--outline">Add<\/button>/g)].length, 1);
  assert.equal([...typed.matchAll(/<button type="submit" class="btn btn--outline" disabled="">Add<\/button>/g)].length, 1);
});

test("a rule that cannot be added says why, and is not offered", () => {
  const long = render({ drafts: { allowInstructions: "x".repeat(PERMISSION_LIMITS.instructionLength + 1), blockInstructions: "" } });
  assert.match(long, /role="alert">That rule is too long\./);
  const quiet = render({ drafts: { allowInstructions: "short", blockInstructions: "" } });
  assert.doesNotMatch(quiet, /That rule is too long\./);
});

test("every control waits while a change is being saved", () => {
  const html = render({ busy: true, state: ready(configured()), drafts: { allowInstructions: "Reply", blockInstructions: "" }, form: { ...emptyPermissionForm(), tool: "bash" } });
  assert.match(html, /<fieldset class="bot-permissions__modes" disabled="">/);
  assert.match(html, /role="switch"[^>]*disabled=""/);
  assert.equal([...html.matchAll(/<button type="button" class="btn btn--ghost" disabled="" aria-label="Remove: /g)].length, 3);
  assert.doesNotMatch(html, /<button type="submit" class="btn btn--outline">/, "no add button is enabled");
  assert.doesNotMatch(html, /<button type="button" class="btn btn--ghost">/, "no remove or reset is enabled");
  assert.equal([...html.matchAll(/class="input bot-permission__select"[^>]*disabled=""/g)].length, 2);
});

test("a refusal is shown, and the alert is hidden when there is none", () => {
  assert.match(render({ error: "That is the most rules you can have in one list." }), /role="alert">That is the most rules you can have in one list\.<\/p>/);
  assert.match(render(), /<p class="hint--bad" role="alert" hidden=""><\/p>/);
});
