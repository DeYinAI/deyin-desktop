/** Renders the Superagent panels from a populated view, to catch a field the markup assumes and the view does not carry. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultSettings, type SuperagentView } from "@deyin/superagent/client";
import { ConfirmDialogProvider } from "../src/components/ConfirmDialog.js";
import { AccountSection } from "../src/components/superagent/AccountSection.js";
import { ActivityTab } from "../src/components/superagent/ActivityTab.js";
import { SettingsTab } from "../src/components/superagent/SettingsTab.js";
import type { SuperagentController } from "../src/components/superagent/useSuperagent.js";

const NOW = Date.parse("2026-02-01T12:00:00Z");

function view(patch: Partial<SuperagentView> = {}): SuperagentView {
  const settings = defaultSettings();
  settings.github.repository = "acme/app";
  settings.policy.sources.github = { allowed: [{ id: "alice" }, { id: "bob", name: "Bob" }], bots: [{ id: "ci[bot]" }], admission: { issues: { unlistedAddressed: "explicit" } } };
  return {
    revision: 1,
    status: {
      enabled: true,
      paused: false,
      mode: "observe",
      ready: true,
      gaps: [],
      repository: "acme/app",
      account: { login: "agent-bot" },
      accountError: null,
      poll: { at: "2026-02-01T11:59:00Z", error: null },
      orchestrator: { running: false },
      workers: { running: 1, max: 2 },
      storeError: null,
    },
    settings,
    settingsRevision: 3,
    tickets: [
      {
        id: "t1", title: "Fix the README typo", state: "person/answer", strength: "explicit", requestedBy: "alice", rules: ["copy"], threads: ["gh:acme/app#1"], prNumber: 2,
        url: "https://github.com/acme/app/pull/2", branch: "fix-readme-t1", directory: "/data/work/fix-readme-t1", attention: "Which README?", createdAt: "2026-02-01T10:00:00Z", updatedAt: "2026-02-01T11:00:00Z",
        assignments: [{ id: "a1", state: "running", startedAt: "2026-02-01T10:01:00Z", report: { state: "blocked", summary: "Two READMEs exist", at: "2026-02-01T10:30:00Z" } }],
        inputs: [{ id: "i1", at: "2026-02-01T10:00:00Z", kind: "trigger", from: "alice", text: "please fix the typo", delivered: true }, { id: "i2", at: "2026-02-01T10:40:00Z", kind: "note", text: "context", delivered: false }],
        undelivered: 1, canStop: true, canRetry: true,
      },
      {
        id: "t2", title: "Done thing", state: "merged", strength: "inferred", requestedBy: "bob", rules: [], threads: [], branch: "", directory: "", ended: { at: "2026-02-01T09:00:00Z", by: "github", reason: "merged" },
        createdAt: "2026-02-01T08:00:00Z", updatedAt: "2026-02-01T09:00:00Z", assignments: [], inputs: [], undelivered: 0, canStop: false, canRetry: false,
      },
    ],
    candidates: [{ triggerId: "g1", thread: "gh:acme/app#5", strength: "inferred", from: "bob", text: "the footer overflows", url: "https://github.com/acme/app/issues/5", delivered: false, since: "2026-02-01T11:50:00Z" }],
    decisions: [
      { id: "d1", at: "2026-02-01T11:00:00Z", kind: "ignore", strength: "inferred", thread: "gh:acme/app#6", reason: "Would accept, recorded only in observe mode", from: "bob", text: "tweak spacing", wouldAccept: true, triggerId: "g2" },
      { id: "d2", at: "2026-02-01T10:00:00Z", kind: "accept", strength: "explicit", thread: "gh:acme/app#1", reason: "Explicit request", ticketId: "t1", wouldAccept: false },
    ],
    receipts: [{ id: "r1", at: "2026-02-01T10:01:00Z", purpose: "acknowledgement", status: "sent", text: "On it.", thread: "gh:acme/app#1", ticketId: "t1" }],
    ...patch,
  };
}

const controller = (): SuperagentController => ({
  view: null, unavailable: null, busy: false, error: null, clearError: () => undefined, act: async () => undefined, ask: async () => undefined,
});

function render(component: Parameters<typeof createElement>[0], props: object): string {
  (globalThis as { window?: unknown }).window = { deyin: { superagent: {}, shell: { openExternal: () => undefined } } };
  return renderToStaticMarkup(createElement(ConfirmDialogProvider, null, createElement(component as never, props)));
}

test("the activity tab shows tickets that need a person first, with their question, details and actions", () => {
  const html = render(ActivityTab, { view: view(), controller: controller(), now: NOW });
  assert.ok(html.indexOf("Fix the README typo") < html.indexOf("Done thing"));
  for (const expected of ["Needs an answer", "Which README?", "requested by @alice", "PR #2", "Retry", "Stop", "fix-readme-t1", "Two READMEs exist", "not delivered yet", "Merged"]) {
    assert.ok(html.includes(expected), `missing: ${expected}`);
  }
  assert.ok(html.includes("the footer overflows") && html.includes("queued since"), "waiting candidate");
  assert.ok(html.includes("would accept") && html.includes("Assess again"), "an observed decision can be sent again");
  assert.ok(html.includes("Observing: inferred requests are recorded, not acted on"));
  assert.ok(html.includes("On it.") && html.includes("acknowledgement"));
});

/** The opening tag of the `<details>` that holds `marker` text in its summary or class. */
const detailsTag = (html: string, className: string): string => {
  const match = html.match(new RegExp(`<details class="${className}"[^>]*>`));
  assert.ok(match, `no <details> with class ${className}`);
  return match[0];
};

test("only the tickets that need a person start open, and everything else is one line", () => {
  const html = render(ActivityTab, { view: view(), controller: controller(), now: NOW });
  const tickets = [...html.matchAll(/<details class="superagent__ticket"[^>]*>/g)].map((m) => m[0]);
  assert.equal(tickets.length, 2);
  assert.match(tickets[0]!, / open/, "the ticket with a question is open");
  assert.doesNotMatch(tickets[1]!, / open/, "a merged ticket is collapsed");
  // The one line carries what is needed to find it: the title, the state and the age.
  assert.match(html, /<summary class="superagent__ticket-head"><span class="superagent__ticket-title">Fix the README typo<\/span>.*?Needs an answer.*?1 h ago/);
});

test("decisions, waiting messages and replies sit in one activity log with their counts", () => {
  const html = render(ActivityTab, { view: view(), controller: controller(), now: NOW });
  assert.equal([...html.matchAll(/class="superagent__log"/g)].length, 1);
  assert.ok(html.includes("Activity log") && html.includes("1 waiting · 2 decisions · 1 reply"));
  // There are tickets to look at, so the log starts closed.
  assert.doesNotMatch(detailsTag(html, "superagent__log"), / open/);
  // Everything is still in the markup, inside the log.
  const log = html.slice(html.indexOf('class="superagent__log"'));
  for (const expected of ["Waiting for assessment", "Recent decisions", "Replies on GitHub"]) assert.ok(log.includes(expected), expected);
});

test("with no tickets the log opens, because what the agent saw is the page", () => {
  const observed = render(ActivityTab, { view: view({ tickets: [] }), controller: controller(), now: NOW });
  assert.match(detailsTag(observed, "superagent__log"), / open/);
  const nothing = render(ActivityTab, { view: view({ tickets: [], candidates: [], decisions: [], receipts: [] }), controller: controller(), now: NOW });
  assert.doesNotMatch(detailsTag(nothing, "superagent__log"), / open/, "nothing to show, nothing to open");
});

test("an empty activity tab explains how a ticket comes about", () => {
  const html = render(ActivityTab, { view: view({ tickets: [], candidates: [], decisions: [], receipts: [] }), controller: controller(), now: NOW });
  assert.ok(html.includes("No tickets yet") && html.includes("Nothing decided yet"));
  assert.ok(!html.includes("Waiting for assessment") && !html.includes("Replies on GitHub"));
});

test("the account section asks for a token until one works, and never shows one", () => {
  const disconnected = render(AccountSection, { view: view({ status: { ...view().status, account: null, accountError: "GitHub rejected the token" } }), controller: controller() });
  assert.ok(disconnected.includes("GitHub rejected the token") && disconnected.includes('type="password"') && disconnected.includes("Connect"));
  const connected = render(AccountSection, { view: view(), controller: controller() });
  assert.ok(connected.includes("@agent-bot") && connected.includes("Check access") && connected.includes("Disconnect"));
  assert.ok(!connected.includes('type="password"'));
});

test("the settings tab renders every section from the stored settings", () => {
  const html = render(SettingsTab, { view: view(), controller: controller(), models: [{ id: "model-a", name: "A" }, { id: "img", name: "I", kind: "image" }], providerId: "openference" });
  for (const section of ["Agent account", "Repository", "Who may ask", "What counts as a request", "Rules", "Assessment", "Workers", "Instructions", "Reset"]) {
    assert.ok(html.includes(section), `missing section: ${section}`);
  }
  assert.ok(html.includes("acme/app") && html.includes("alice") && html.includes("ci[bot]"));
  assert.ok(html.includes("Copy fixes") && html.includes("Visual fixes"));
  // Dropdowns are menus: closed, each shows only its current choice. The choices themselves are covered by the model tests.
  assert.ok(html.includes("The app&#x27;s default model"), "an unset model reads as the app's default");
  assert.ok(html.includes('aria-label="Assessment mode: ') && html.includes('aria-label="Worker model: '), "every control says what it is for");
  assert.ok(!html.includes("<select"), "no native select is left to draw the operating system's popup");
  assert.ok(html.includes("Treat as a request"), "the admission table shows its current choices");
  assert.ok(!html.includes("Unsaved changes"), "an untouched form has no save bar");
});

test("the settings page asks one question per source and keeps the full table under Advanced policy", () => {
  const html = render(SettingsTab, { view: view(), controller: controller(), models: [], providerId: "openference" });
  // Three controls up front, one per source, each showing the stored value (issues was set to explicit in the fixture).
  const headline = [...html.matchAll(/aria-label="Mentions from anyone else, in ([^":]+): ([^"]+)"/g)];
  assert.deepEqual(headline.map((m) => m[1]), ["Issues", "Pull requests", "Comments"]);
  assert.equal(headline[0]![2], "Treat as a request");
  assert.equal(headline[1]![2], "Ignore");
  assert.ok(html.includes("Ignore is the safe choice"), "the risk of the permissive choice is stated");
  // The full 3x3 table is still there, in a closed section: nothing in it differs from its default.
  const advanced = html.slice(html.indexOf('class="superagent__advanced"'));
  assert.ok(advanced.includes("Anyone else, not addressed to the agent") && advanced.includes("Allowed account, not addressed to the agent"));
  assert.doesNotMatch(detailsTag(html, "superagent__advanced"), / open/);
  assert.ok(!html.includes("changed from default"));
});

test("Advanced policy opens and says so when a cell in it is not at its default", () => {
  const changed = view();
  changed.settings.policy.sources.github = { allowed: [{ id: "alice" }], bots: [], admission: { comments: { unlistedUnaddressed: "inferred" } } };
  const html = render(SettingsTab, { view: changed, controller: controller(), models: [], providerId: "openference" });
  assert.match(detailsTag(html, "superagent__advanced"), / open/, "a policy that lets more through is never hidden");
  assert.ok(html.includes("1 changed from default"));
});
