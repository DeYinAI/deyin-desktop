/** Renders the logo's product switcher in each state a host can put it in. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductSwitcher } from "../src/components/ProductSwitcher.js";
import { PRODUCTS, availableProducts } from "../src/products.js";

const noop = () => undefined;

function render(props: { chatOnly?: boolean; active?: "code" | "bot" | "conductor"; variant?: "sidebar" | "rail" }): string {
  return renderToStaticMarkup(
    createElement(ProductSwitcher, {
      products: availableProducts(props.chatOnly ?? false),
      active: props.active ?? "code",
      onSelect: noop,
      variant: props.variant ?? "sidebar",
    }),
  );
}

test("the sidebar trigger shows the active product's mark and name with a menu chevron", () => {
  const html = render({ active: "bot" });
  assert.match(html, /Deyin Bot/);
  assert.doesNotMatch(html, /Deyin Code/, "only the active product is named while the menu is closed");
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /product-switcher__chevron/);
});

test("each product's mark is tinted with its own color", () => {
  for (const id of ["code", "bot", "conductor"] as const) {
    const html = render({ active: id });
    assert.ok(html.includes(`stroke="${PRODUCTS[id].tint}"`), `${id} mark uses ${PRODUCTS[id].tint}`);
    assert.doesNotMatch(html, /deyinInk/, "a tinted mark never references the shared gradient");
  }
  const tints = new Set(Object.values(PRODUCTS).map((p) => p.tint));
  assert.equal(tints.size, 3, "the three products are visually distinct");
});

test("the trigger names itself for assistive tech with the current product", () => {
  assert.match(render({ active: "conductor" }), /aria-label="Switch product: Deyin Conductor"/);
});

test("the collapsed rail variant shows the mark alone", () => {
  const html = render({ variant: "rail", active: "conductor" });
  assert.match(html, /product-switcher--rail/);
  assert.doesNotMatch(html, /product-switcher__name/);
  assert.doesNotMatch(html, /product-switcher__chevron/);
  assert.match(html, /aria-label="Switch product: Deyin Conductor"/, "still named, since there is no visible text");
});

test("a chat-only host renders a plain brand mark with no menu", () => {
  const html = render({ chatOnly: true });
  assert.match(html, /Deyin Code/);
  assert.match(html, /product-switcher--static/);
  assert.doesNotMatch(html, /aria-haspopup/);
  assert.doesNotMatch(html, /<button/);
});

test("an active product the host does not offer falls back to the first one rather than crashing", () => {
  const html = render({ chatOnly: true, active: "bot" });
  assert.match(html, /Deyin Code/);
});

test("renders nothing when no products are available", () => {
  const html = renderToStaticMarkup(createElement(ProductSwitcher, { products: [], active: "code", onSelect: noop, variant: "sidebar" }));
  assert.equal(html, "");
});
