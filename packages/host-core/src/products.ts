import type { ProductId } from "./types.js";

/** Every product, in the order the switcher lists them. */
export const PRODUCT_IDS: readonly ProductId[] = ["code", "bot", "conductor"];

/** True when `value` names a product. Saved settings and places are untrusted input. */
export function isProductId(value: unknown): value is ProductId {
  return typeof value === "string" && (PRODUCT_IDS as readonly string[]).includes(value);
}
