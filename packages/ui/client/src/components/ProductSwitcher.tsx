import { useState } from "react";
import type { ProductId } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import type { Product } from "../products.js";
import { AnchoredMenu } from "./AnchoredMenu.js";
import { Icon } from "./Icon.js";
import { Logo } from "./Logo.js";

interface ProductSwitcherProps {
  /** The products this host offers. With a single one the switcher is a plain brand mark. */
  products: readonly Product[];
  active: ProductId;
  onSelect: (id: ProductId) => void;
  /** `sidebar` shows mark, name and chevron; `rail` shows the mark alone for the collapsed rail. */
  variant: "sidebar" | "rail";
}

/**
 * The ChatGPT-style product menu on the logo. Picking a product switches the whole shell;
 * the title bar, settings and search stay put because they are not part of any product.
 */
export function ProductSwitcher(props: ProductSwitcherProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const current = props.products.find((product) => product.id === props.active) ?? props.products[0];
  if (!current) return null;

  const mark = <Logo size={props.variant === "rail" ? 24 : 22} tint={current.tint} />;
  const name = <span className="product-switcher__name">{current.label}</span>;

  if (props.products.length < 2) {
    return (
      <div className={`product-switcher product-switcher--${props.variant} product-switcher--static`}>
        {mark}
        {props.variant === "sidebar" && name}
      </div>
    );
  }

  const choose = (id: ProductId) => {
    setOpen(false);
    if (id !== props.active) props.onSelect(id);
  };

  return (
    <AnchoredMenu
      open={open}
      onToggle={() => setOpen((v) => !v)}
      onClose={() => setOpen(false)}
      className={`product-switcher product-switcher--${props.variant}`}
      triggerClassName="product-switcher__trigger"
      triggerTitle={t("product.switcher")}
      triggerAriaLabel={`${t("product.switcher")}: ${current.label}`}
      panelClassName="product-switcher__panel"
      trigger={
        <>
          {mark}
          {props.variant === "sidebar" && (
            <>
              {name}
              <span className="product-switcher__chevron" aria-hidden>
                <Icon name="chevronDown" size={14} />
              </span>
            </>
          )}
        </>
      }
    >
      <div role="menu" aria-label={t("product.switcher")}>
        {props.products.map((product) => (
          <button
            key={product.id}
            type="button"
            role="menuitemradio"
            aria-checked={product.id === props.active}
            className={`menu__item product-switcher__item${product.id === props.active ? " product-switcher__item--active" : ""}`}
            onClick={() => choose(product.id)}
          >
            <span className="product-switcher__item-mark">
              <Logo size={26} tint={product.tint} />
            </span>
            <span className="product-switcher__item-text">
              <span className="product-switcher__item-name">{product.label}</span>
              <span className="product-switcher__item-tagline">{t(product.taglineKey)}</span>
            </span>
            {product.id === props.active && (
              <span className="product-switcher__check" aria-hidden>
                <Icon name="check" size={15} />
              </span>
            )}
          </button>
        ))}
      </div>
    </AnchoredMenu>
  );
}
