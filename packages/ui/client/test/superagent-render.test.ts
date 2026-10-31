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
  assert.ok(html.includes("model-a") && !html.includes(">img<"), "image models are not offered");
  assert.ok(html.includes("Treat as a request"), "the admission table offers its choices");
  assert.ok(!html.includes("Unsaved changes"), "an untouched form has no save bar");
});
