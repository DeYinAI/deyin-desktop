import type { MessageKey, ProductId } from "@deyin/host-core/shared";
import type { IconName } from "./components/Icon.js";
import { PRODUCTS } from "./products.js";
import type { View } from "./views.js";

export type NavItemId = "new" | "search" | "plugins" | "workflows" | "automations" | "superagent" | "customize";

/** A label that is either translated or fixed text (a few of the original nav rows were never translated). */
export type NavLabel = { key: MessageKey } | { text: string };

export interface NavItem {
  id: NavItemId;
  icon: IconName;
  label: NavLabel;
  active: boolean;
}

export function navLabelText(t: (key: MessageKey) => string, label: NavLabel): string {
  return "key" in label ? t(label.key) : label.text;
}

/**
 * The collapsed rail's buttons for a product. Search, Plugins and Customize are shared chrome and
 * always there; the rest depend on the product (Pipelines are Conductor's, Superagent belongs to the
 * code products) and on the host (a web build has no automations or Superagent).
 */
export function productNavItems(product: ProductId, platform: "desktop" | "web", activeView: View): NavItem[] {
  const desktop = platform !== "web";
  const items: NavItem[] = [
    { id: "new", icon: "plusCircle", label: { key: PRODUCTS[product].newItemKey }, active: false },
    { id: "search", icon: "search", label: { key: "nav.search" }, active: false },
    { id: "plugins", icon: "puzzle", label: { text: "Plugins" }, active: activeView === "plugins" },
  ];
  if (product === "conductor") {
    items.push({ id: "workflows", icon: "bolt", label: { key: "conductor.pipelines" }, active: activeView === "workflows" });
  }
  if (desktop) {
    items.push({ id: "automations", icon: "clock", label: { text: "Automation tasks" }, active: activeView === "automations" });
  }
  if (desktop && product !== "bot") {
    items.push({ id: "superagent", icon: "rocket", label: { key: "nav.superagent" }, active: activeView === "superagent" });
  }
  items.push({ id: "customize", icon: "palette", label: { key: "nav.customize" }, active: false });
  return items;
}
