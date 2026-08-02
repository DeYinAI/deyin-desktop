import { loadStripe } from "@stripe/stripe-js";
import type { Upgrade3dsResult } from "../../shared/types.js";

const FINALIZE_BACKOFF_MS = [1000, 2000, 3000];

export async function confirmUpgradeWith3ds(
  clientSecret: string,
  newSubscriptionId: string,
): Promise<Upgrade3dsResult> {
  const pk = await window.deyin.billing.publishableKey();
  if (!pk) {
    await window.deyin.billing.abortCrossCurrencyUpgrade(newSubscriptionId);
    return { ok: false, error: "Payment form could not be loaded." };
  }

  const stripe = await loadStripe(pk);
  if (!stripe) {
    await window.deyin.billing.abortCrossCurrencyUpgrade(newSubscriptionId);
    return { ok: false, error: "Payment provider could not be loaded." };
  }

  const result = await stripe.confirmCardPayment(clientSecret);
  if (result.error) {
    await window.deyin.billing.abortCrossCurrencyUpgrade(newSubscriptionId);
    return { ok: false, error: result.error.message || "Card authentication failed." };
  }

  const status = result.paymentIntent?.status;
  if (!result.paymentIntent || (status !== "succeeded" && status !== "processing")) {
    await window.deyin.billing.abortCrossCurrencyUpgrade(newSubscriptionId);
    return { ok: false, error: "Card authentication did not complete." };
  }

  // Payment submitted — never abort after this point.
  let lastError = "Upgrade is finalizing. Refresh in a moment.";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await window.deyin.billing.completeCrossCurrencyUpgrade(newSubscriptionId);
      if (data.success) {
        return { ok: true, redirect: data.redirect };
      }
      lastError = data.error || lastError;
    } catch (err) {
      lastError = err instanceof Error ? err.message : lastError;
    }
    if (attempt < FINALIZE_BACKOFF_MS.length) {
      await new Promise((r) => setTimeout(r, FINALIZE_BACKOFF_MS[attempt]!));
    }
  }

  return { ok: false, error: lastError };
}
