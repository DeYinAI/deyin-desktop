/**
 * Bot Mode availability contract: a chat-only host (chat.openference.com) has no
 * local shell or git, so the mode's pipelines and external agent CLIs cannot run
 * there. These assertions pin the two things a user actually sees: the collapsed
 * rail offers no Workspace/Bot switch, and the composer offers no `/bot` command.
 *
 * Both props default to available, so the desktop app keeps every entry point.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NavRail } from "../src/components/NavRail.js";
import { I18nProvider } from "../src/i18n.js";

const noop = () => {};

function renderRail(extra: { botModeAvailable?: boolean }): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { language: "en" },
      createElement(NavRail, {
        activeView: "workspace",
        currentMode: "agent",
        onSwitchMode: noop,
        onSelectView: noop,
        onNewTask: noop,
        onOpenPlugins: noop,
        onOpenSearch: noop,
        onOpenAutomations: noop,
        onOpenSuperagent: noop,
        onOpenCustomize: noop,
        onOpenSettings: noop,
        ...extra,
      }),
    ),
  );
}

/** The rail's own buttons, by accessible name. */
function railLabels(markup: string): string[] {
  return [...markup.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]!);
}

test("NavRail: a full host offers the Workspace/Bot switch", () => {
  const labels = railLabels(renderRail({ botModeAvailable: true }));
  assert.ok(labels.includes("Bot Mode"), `expected a Bot Mode button, got ${labels.join(", ")}`);
  assert.ok(labels.includes("Workspace"), "expected the paired Workspace button");
});

test("NavRail: a chat-only host hides Bot Mode and its Workspace pair", () => {
  const labels = railLabels(renderRail({ botModeAvailable: false }));
  assert.ok(!labels.includes("Bot Mode"), `Bot Mode must not render when unavailable`);
  // The pair exists to move between the two views, so both halves go together.
  assert.ok(!labels.includes("Workspace"), "the Workspace half of the pair goes with Bot Mode");
  // Everything else is unaffected: hiding Bot Mode must not empty the rail.
  assert.ok(labels.includes("Plugins"));
  assert.ok(labels.includes("New session"));
});

test("NavRail: unavailable Bot Mode keeps the rail usable", () => {
  const markup = renderRail({ botModeAvailable: false });
  const buttons = [...markup.matchAll(/<button/g)].length;
  assert.ok(buttons >= 4, `expected the rail to keep its other buttons, found ${buttons}`);
});

test("NavRail: omitting the flag keeps Bot Mode, so desktop is unchanged", () => {
  const labels = railLabels(renderRail({}));
  assert.ok(labels.includes("Bot Mode"), "an unspecified host keeps the full rail");
});
