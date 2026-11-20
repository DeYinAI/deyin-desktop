/**
 * Product availability contract for the collapsed rail. A chat-only host (chat.openference.com) has no
 * local shell or git, so Conductor's pipelines and external agent CLIs, and Bots' runtime, cannot run
 * there: such a host offers Deyin Code alone, and the rail shows a plain brand mark instead of a switcher.
 * A full host keeps the switcher with every product.
 *
 * Which products a host offers is `availableProducts(chatOnly)`; the rail renders whatever it is given.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProductId } from "@deyin/host-core/shared";
import { NavRail } from "../src/components/NavRail.js";
import { I18nProvider } from "../src/i18n.js";
import { availableProducts } from "../src/products.js";
import type { View } from "../src/views.js";

const noop = () => {};

function renderRail(opts: { chatOnly?: boolean; product?: ProductId; view?: View; platform?: "desktop" | "web" }): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { language: "en" },
      createElement(NavRail, {
        activeView: opts.view ?? "workspace",
        platform: opts.platform ?? "desktop",
        products: availableProducts(opts.chatOnly ?? false),
        activeProduct: opts.product ?? "code",
        onSelectProduct: noop,
        onNewItem: noop,
        onOpenPlugins: noop,
        onOpenSearch: noop,
        onOpenAutomations: noop,
        onOpenSuperagent: noop,
        onOpenWorkflows: noop,
        onOpenCustomize: noop,
        onOpenSettings: noop,
      }),
    ),
  );
}

/** The rail's own buttons, by accessible name. */
function railLabels(markup: string): string[] {
  return [...markup.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]!);
}

test("NavRail: a full host offers the product switcher", () => {
  const labels = railLabels(renderRail({}));
  assert.ok(labels.includes("Switch product: Deyin Code"), `expected the switcher, got ${labels.join(", ")}`);
});

test("NavRail: the switcher names the product that is open", () => {
  assert.ok(railLabels(renderRail({ product: "conductor", view: "conductor" })).includes("Switch product: Deyin Conductor"));
  assert.ok(railLabels(renderRail({ product: "bot", view: "bot" })).includes("Switch product: Deyin Bot"));
});

test("NavRail: a chat-only host has no switcher, because it offers only Code", () => {
  const labels = railLabels(renderRail({ chatOnly: true }));
  assert.ok(!labels.some((label) => label.startsWith("Switch product")), "no product switch on a host that has one product");
  // Everything else is unaffected: dropping the switcher must not empty the rail.
  assert.ok(labels.includes("Plugins"));
  assert.ok(labels.includes("New session"));
});

test("NavRail: a chat-only host keeps the rest of its rail", () => {
  const buttons = [...renderRail({ chatOnly: true }).matchAll(/<button/g)].length;
  assert.ok(buttons >= 4, `expected the rail to keep its other buttons, found ${buttons}`);
});

test("NavRail: Conductor's rail has Pipelines and a New run button", () => {
  const labels = railLabels(renderRail({ product: "conductor", view: "conductor" }));
  assert.ok(labels.includes("Pipelines"));
  assert.ok(labels.includes("New run"));
});

test("NavRail: Code's rail has neither Pipelines nor a New run button", () => {
  const labels = railLabels(renderRail({}));
  assert.ok(!labels.includes("Pipelines"));
  assert.ok(!labels.includes("New run"));
});

test("NavRail: Bot's rail creates a Bot and has no Superagent or Pipelines", () => {
  const labels = railLabels(renderRail({ product: "bot", view: "bot" }));
  assert.ok(labels.includes("New Bot"));
  assert.ok(!labels.includes("Superagent"));
  assert.ok(!labels.includes("Pipelines"));
});

test("NavRail: the Workspace/Conductor button pair is gone, replaced by the switcher", () => {
  const labels = railLabels(renderRail({}));
  assert.ok(!labels.includes("Workspace"));
  assert.ok(!labels.includes("Conductor"));
});

test("NavRail: the open shared page is marked active", () => {
  const html = renderRail({ view: "plugins" });
  assert.match(html, /nav-rail__btn nav-rail__btn--active"[^>]*aria-label="Plugins"/);
});
