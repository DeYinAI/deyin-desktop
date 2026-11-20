import type { ProductId } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { navLabelText, productNavItems, type NavItemId } from "../navItems.js";
import type { Product } from "../products.js";
import type { View } from "../views.js";
import { Icon } from "./Icon.js";
import { ProductSwitcher } from "./ProductSwitcher.js";
import { UpdateBanner } from "./UpdateBanner.js";

interface NavRailProps {
  /** Which top-level view is showing, so its rail button reads as selected. */
  activeView: View;
  platform: "desktop" | "web";
  /** The products this host offers; a chat-only host has only Code and shows a plain mark. */
  products: readonly Product[];
  activeProduct: ProductId;
  onSelectProduct: (id: ProductId) => void;
  /** Create the product's own kind of item: a session, a Bot or a run. */
  onNewItem: () => void;
  onOpenPlugins: () => void;
  onOpenSearch: () => void;
  onOpenAutomations: () => void;
  onOpenSuperagent: () => void;
  onOpenWorkflows: () => void;
  onOpenCustomize: () => void;
  onOpenSettings: () => void;
}

/** Collapsed-sidebar stand-in: the product switcher and the sidebar's nav actions as a narrow icon strip,
 *  mirroring the workspace panel's rail on the opposite edge. The expand control
 *  is the title bar's sidebar toggle. */
export function NavRail(props: NavRailProps) {
  const t = useT();
  const onItem: Record<NavItemId, () => void> = {
    new: props.onNewItem,
    search: props.onOpenSearch,
    plugins: props.onOpenPlugins,
    workflows: props.onOpenWorkflows,
    automations: props.onOpenAutomations,
    superagent: props.onOpenSuperagent,
    customize: props.onOpenCustomize,
  };
  const items = productNavItems(props.activeProduct, props.platform, props.activeView);

  return (
    <nav className="nav-rail" aria-label="Navigation">
      <ProductSwitcher products={props.products} active={props.activeProduct} onSelect={props.onSelectProduct} variant="rail" />
      <div className="nav-rail__items">
        {items.map((item) => {
          const label = navLabelText(t, item.label);
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-rail__btn${item.active ? " nav-rail__btn--active" : ""}`}
              title={label}
              aria-label={label}
              onClick={onItem[item.id]}
            >
              <Icon name={item.icon} size={14} />
            </button>
          );
        })}
      </div>

      <div className="nav-rail__footer">
        <UpdateBanner variant="rail" />
        <button
          type="button"
          className="nav-rail__btn"
          title={t("nav.settings")}
          aria-label={t("nav.settings")}
          onClick={props.onOpenSettings}
        >
          <Icon name="gear" size={14} />
        </button>
      </div>
    </nav>
  );
}
