import assert from "node:assert/strict";
import test from "node:test";
import { navLabelText, productNavItems, type NavItemId } from "../src/navItems.js";
import { viewAfterPanelOpen, type View } from "../src/views.js";

const ids = (items: ReturnType<typeof productNavItems>): NavItemId[] => items.map((item) => item.id);

test("Code's rail has the shared chrome plus automations and Superagent, and no Pipelines", () => {
  assert.deepEqual(ids(productNavItems("code", "desktop", "workspace")), ["new", "search", "plugins", "automations", "superagent", "customize"]);
});

test("Conductor's rail adds Pipelines after Plugins", () => {
  assert.deepEqual(ids(productNavItems("conductor", "desktop", "conductor")), ["new", "search", "plugins", "workflows", "automations", "superagent", "customize"]);
});

test("Bot's rail has no Pipelines and no Superagent", () => {
  assert.deepEqual(ids(productNavItems("bot", "desktop", "bot")), ["new", "search", "plugins", "automations", "customize"]);
});

test("a web build drops automations and Superagent for every product", () => {
  for (const product of ["code", "conductor", "bot"] as const) {
    const found = ids(productNavItems(product, "web", "workspace"));
    assert.ok(!found.includes("automations"), product);
    assert.ok(!found.includes("superagent"), product);
  }
});

test("the first button creates the product's own kind of item", () => {
  const label = (product: "code" | "bot" | "conductor") => navLabelText((key) => key, productNavItems(product, "desktop", "workspace")[0]!.label);
  assert.equal(label("code"), "product.code.new");
  assert.equal(label("bot"), "product.bot.new");
  assert.equal(label("conductor"), "conductor.newRun");
});

test("only the button for the open view reads as active", () => {
  const active = (view: View) => productNavItems("conductor", "desktop", view).filter((item) => item.active).map((item) => item.id);
  assert.deepEqual(active("plugins"), ["plugins"]);
  assert.deepEqual(active("workflows"), ["workflows"]);
  assert.deepEqual(active("automations"), ["automations"]);
  assert.deepEqual(active("superagent"), ["superagent"]);
  assert.deepEqual(active("workspace"), []);
  assert.deepEqual(active("settings"), []);
});

test("navLabelText translates keyed labels and passes fixed text through", () => {
  const t = (key: string) => `<${key}>`;
  assert.equal(navLabelText(t, { key: "nav.search" }), "<nav.search>");
  assert.equal(navLabelText(t, { text: "Plugins" }), "Plugins");
});

test("opening a right panel keeps Conductor in Conductor", () => {
  assert.equal(viewAfterPanelOpen("conductor"), "conductor");
});

test("opening a right panel from a Bot's page returns to that Bot's chat", () => {
  assert.equal(viewAfterPanelOpen("bot"), "bot");
  assert.equal(viewAfterPanelOpen("botDetail"), "bot");
  assert.equal(viewAfterPanelOpen("botMarket"), "bot");
});

test("opening a right panel from any other view surfaces the Code workspace", () => {
  for (const view of ["workspace", "settings", "upgrade", "automations", "plugins", "superagent", "workflows"] as const) {
    assert.equal(viewAfterPanelOpen(view), "workspace", view);
  }
});
