import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPlanCardPresentation,
  estimateProratedCharge,
  estimateRefund,
  formatBillingDate,
  formatPlanPrice,
  formatQuota,
  hasActiveSubscription,
  isAllowedCheckoutUrl,
  isCheckoutCanceledUrl,
  isCheckoutSuccessUrl,
  isCrossCurrencyChange,
  isPlanDowngrade,
  pendingPlanSwitchForCard,
  pendingSwitchOnCurrentPlanCard,
  scheduledCancellationForPlanCard,
  type BillingOverview,
  type PlanCardCtaKey,
  type PublicPlan,
} from "@deyin/host-core/shared";
import { confirmUpgradeWith3ds } from "../billing/confirmUpgradeWith3ds.js";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";
import { BillingCycleToggle } from "./billing/BillingCycleToggle.js";
import { CrossCurrencyDialog } from "./billing/CrossCurrencyDialog.js";
import { PlanDowngradeDialog } from "./billing/PlanDowngradeDialog.js";
import { PurchaseAgreementDialog } from "./billing/PurchaseAgreementDialog.js";

type PlanTab = "coding" | "agent";
type Step = "select" | "checkout" | "success";

interface PurchasePending {
  selectionPlanId: number;
  planName: string;
  displayPrice: number;
  currency: string;
  changeNow?: boolean;
}

interface PlansViewProps {
  platform: "desktop" | "web";
  oauthIssuer: string;
  userPlan: string | null;
  onBack: () => void;
  onComplete: () => void;
}

function featureLines(features: string | null): string[] {
  if (!features?.trim()) return [];
  return features.split("\n").map((line) => line.trim()).filter(Boolean);
}

const CTA_KEYS: Record<PlanCardCtaKey, string> = {
  processing: "plans.cta.processing",
  switchToAnnual: "plans.cta.switchToAnnual",
  switchToMonthly: "plans.cta.switchToMonthly",
  current: "plans.cta.current",
  switchToFree: "plans.cta.switchToFree",
  startFree: "plans.cta.startFree",
  switchPlan: "plans.cta.switchPlan",
  subscribe: "plans.cta.subscribe",
};

export function PlansView({ platform, oauthIssuer, userPlan, onBack, onComplete }: PlansViewProps) {
  const t = useT();
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);
  const [overview, setOverview] = useState<BillingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [planTab, setPlanTab] = useState<PlanTab>("coding");
  const [isAnnual, setIsAnnual] = useState(false);
  const [step, setStep] = useState<Step>("select");
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [loadingPlanId, setLoadingPlanId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPortalAction, setShowPortalAction] = useState(false);
  const [pendingDowngradePlanId, setPendingDowngradePlanId] = useState<number | null>(null);
  const [pendingCrossCurrencyPlanId, setPendingCrossCurrencyPlanId] = useState<number | null>(null);
  const [pendingPurchase, setPendingPurchase] = useState<PurchasePending | null>(null);
  const webviewRef = useRef<HTMLElement | null>(null);
  const tabInitialized = useRef(false);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const refreshOverview = useCallback(async () => {
    const data = await window.deyin.billing.overview();
    if (!mountedRef.current) return data;
    setOverview(data);
    if (data?.subscriptionBillingCycle) setIsAnnual(data.subscriptionBillingCycle === "annual");
    return data;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [catalog, billing] = await Promise.all([
        window.deyin.plans.list(),
        window.deyin.billing.overview(),
      ]);
      if (!mountedRef.current) return;
      setPlans(catalog);
      setOverview(billing);
      if (billing?.subscriptionBillingCycle) setIsAnnual(billing.subscriptionBillingCycle === "annual");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const currentPlanId = overview?.planId ?? null;
  const currentPlanName = overview?.planName ?? userPlan;
  const currentPlanPriceMonthly = overview?.planPriceMonthly ?? null;
  const nextBillingDate = overview?.nextBillingDate ?? null;
  const pendingPlanChange = overview?.pendingPlanChange ?? null;
  const subscriptionCurrency = overview?.subscriptionCurrency ?? null;
  const hasSubscription = hasActiveSubscription({
    stripeSubscriptionId: overview?.stripeSubscriptionId ?? null,
    subscriptionStatus: overview?.subscriptionStatus ?? null,
  });

  useEffect(() => {
    if (tabInitialized.current || !plans?.length || !currentPlanName) return;
    const current = plans.find((p) => p.name.trim().toLowerCase() === currentPlanName.trim().toLowerCase());
    if (current) {
      setPlanTab(current.planKind === "agent" ? "agent" : "coding");
      tabInitialized.current = true;
    }
  }, [plans, currentPlanName]);

  const visiblePlans = useMemo(
    () => (plans ?? []).filter((p) => (planTab === "agent" ? p.planKind === "agent" : p.planKind !== "agent")),
    [plans, planTab],
  );

  const upgradeUrl = `${oauthIssuer.replace(/\/$/, "")}/app/user/billing/upgrade`;
  const openExternalBilling = () => {
    if (platform === "desktop") window.deyin.shell.openExternal(upgradeUrl);
    else window.open(upgradeUrl, "_blank", "noopener");
  };

  const handleCheckoutNav = useCallback(
    (url: string) => {
      if (isCheckoutSuccessUrl(oauthIssuer, url)) {
        setStep("success");
        void refreshOverview().then(() => window.setTimeout(() => onComplete(), 1200));
        return;
      }
      if (isCheckoutCanceledUrl(oauthIssuer, url)) {
        setCheckoutUrl(null);
        setStep("select");
        setError(t("plans.checkoutCanceled"));
      }
    },
    [oauthIssuer, onComplete, refreshOverview, t],
  );

  useEffect(() => {
    const view = webviewRef.current;
    if (!view || platform !== "desktop" || step !== "checkout") return;
    const onNavigate = (e: Event) => {
      const url = (e as Event & { url?: string }).url;
      if (url) handleCheckoutNav(url);
    };
    view.addEventListener("did-navigate", onNavigate);
    view.addEventListener("did-navigate-in-page", onNavigate);
    return () => {
      view.removeEventListener("did-navigate", onNavigate);
      view.removeEventListener("did-navigate-in-page", onNavigate);
    };
  }, [handleCheckoutNav, platform, step, checkoutUrl]);

  const performPlanSelection = useCallback(
    async (planId: number, changeNow?: boolean) => {
      setLoadingPlanId(planId);
      setError(null);
      setNotice(null);
      setShowPortalAction(false);
      setPendingDowngradePlanId(null);
      setPendingCrossCurrencyPlanId(null);

      const targetPlan = plans?.find((p) => p.id === planId);
      const isScheduledFreeCancel =
        targetPlan?.priceMonthly === 0 && changeNow === false && hasSubscription;
      const isScheduledPaidChange =
        changeNow === false && hasSubscription && !!targetPlan && targetPlan.priceMonthly > 0;

      try {
        const data = await window.deyin.billing.selectPlan(planId, {
          returnTo: "/user/billing/overview",
          billingCycle: isAnnual ? "annual" : "monthly",
          changeNow,
        });

        if (data.requires_action && data.client_secret && data.new_subscription_id) {
          const threeDs = await confirmUpgradeWith3ds(data.client_secret, data.new_subscription_id);
          if (!threeDs.ok) {
            setError(threeDs.error);
            return;
          }
          setStep("success");
          await refreshOverview();
          window.setTimeout(() => onComplete(), 1200);
          return;
        }

        if (data.url) {
          if (!isAllowedCheckoutUrl(oauthIssuer, data.url)) {
            setError(t("plans.checkoutFailed"));
            return;
          }
          setCheckoutUrl(data.url);
          setStep("checkout");
          return;
        }

        if (data.redirect || data.success) {
          await refreshOverview();
          if (isScheduledFreeCancel || isScheduledPaidChange) {
            setNotice(t("plans.notice.scheduled"));
          } else if (data.fallback_to_scheduled && data.message) {
            setNotice(data.message);
          } else {
            setStep("success");
            window.setTimeout(() => onComplete(), 1200);
          }
          return;
        }

        if (data.requires_action) {
          setError(t("plans.requiresAction"));
          setShowPortalAction(true);
          return;
        }

        setError(t("plans.checkoutFailed"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : t("plans.checkoutFailed");
        setError(msg);
        const fallback = (err as { fallback?: string }).fallback;
        setShowPortalAction(!!fallback || /portal|billing portal/i.test(msg));
      } finally {
        setLoadingPlanId(null);
      }
    },
    [hasSubscription, isAnnual, oauthIssuer, onComplete, plans, refreshOverview, t],
  );

  const handleSelectPlan = useCallback(
    (planId: number) => {
      const targetPlan = plans?.find((p) => p.id === planId);
      if (!targetPlan) return;

      const pres = buildPlanCardPresentation({
        plan: targetPlan,
        currentPlanId,
        currentPlanName,
        currentPlanPriceMonthly,
        publicPlans: plans ?? [],
        hasSubscription,
        isAnnual,
        currentBillingCycle: overview?.subscriptionBillingCycle ?? null,
        isLoading: loadingPlanId === planId,
      });

      if (pres.billingCycleSwitch) {
        setError(null);
        void performPlanSelection(pres.selectionPlanId, false);
        return;
      }

      if (pres.isCurrent) return;

      if (pendingPlanChange?.planId === planId) return;

      setError(null);

      if (
        isPlanDowngrade({
          hasSubscription,
          targetPlan,
          currentPlanId,
          currentPlanPriceMonthly,
          publicPlans: plans ?? [],
        })
      ) {
        setPendingDowngradePlanId(planId);
        return;
      }

      if (
        hasSubscription &&
        targetPlan.priceMonthly > 0 &&
        isCrossCurrencyChange({
          hasSubscription,
          targetPlan,
          subscriptionCurrency,
        })
      ) {
        setPendingCrossCurrencyPlanId(planId);
        return;
      }

      if (targetPlan.priceMonthly > 0) {
        setPendingPurchase({
          selectionPlanId: pres.selectionPlanId,
          planName: targetPlan.name,
          displayPrice: pres.displayPrice,
          currency: pres.currency,
        });
        return;
      }

      void performPlanSelection(pres.selectionPlanId);
    },
    [
      currentPlanId,
      currentPlanName,
      currentPlanPriceMonthly,
      hasSubscription,
      isAnnual,
      loadingPlanId,
      overview?.subscriptionBillingCycle,
      pendingPlanChange?.planId,
      performPlanSelection,
      plans,
      subscriptionCurrency,
    ],
  );

  const confirmCrossCurrencyNow = () => {
    if (!pendingCrossCurrencyPlanId || !plans) return;
    const target = plans.find((p) => p.id === pendingCrossCurrencyPlanId);
    if (!target) {
      setPendingCrossCurrencyPlanId(null);
      return;
    }
    const pres = buildPlanCardPresentation({
      plan: target,
      currentPlanId,
      currentPlanName,
      currentPlanPriceMonthly,
      publicPlans: plans,
      hasSubscription,
      isAnnual,
      currentBillingCycle: overview?.subscriptionBillingCycle ?? null,
      isLoading: false,
    });
    setPendingCrossCurrencyPlanId(null);
    setPendingPurchase({
      selectionPlanId: pres.selectionPlanId,
      planName: target.name,
      displayPrice: pres.displayPrice,
      currency: pres.currency,
      changeNow: true,
    });
  };

  const confirmCrossCurrencyNextCycle = () => {
    if (!pendingCrossCurrencyPlanId) return;
    const planId = pendingCrossCurrencyPlanId;
    setPendingCrossCurrencyPlanId(null);
    void performPlanSelection(planId, false);
  };

  const confirmPurchase = () => {
    if (!pendingPurchase) return;
    const { selectionPlanId, changeNow } = pendingPurchase;
    setPendingPurchase(null);
    void performPlanSelection(selectionPlanId, changeNow);
  };

  const handleBack = () => {
    if (step === "checkout") {
      setCheckoutUrl(null);
      setStep("select");
      setError(null);
      return;
    }
    onBack();
  };

  const crossCurrencyTarget = pendingCrossCurrencyPlanId
    ? plans?.find((p) => p.id === pendingCrossCurrencyPlanId)
    : null;
  const downgradeTarget = pendingDowngradePlanId ? plans?.find((p) => p.id === pendingDowngradePlanId) : null;

  return (
    <div className="plans-view">
      <header className="plans-view__head">
        <button type="button" className="icon-btn plans-view__back" title={t("plans.back")} onClick={handleBack}>
          <Icon name="arrowLeft" size={14} />
        </button>
        <div className="plans-view__titles">
          <h1 className="plans-view__title">{t("plans.title")}</h1>
          <p className="plans-view__desc">{step === "checkout" ? t("plans.checkoutSubtitle") : t("plans.subtitle")}</p>
        </div>
      </header>

      {step === "select" && (
        <div className="plans-view__body">
          <div className="plans-view__toolbar">
            <div className="plans-view__tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={planTab === "coding"}
                className={`wstab ${planTab === "coding" ? "wstab--active" : ""}`}
                onClick={() => setPlanTab("coding")}
              >
                {t("plans.codingPlanTab")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={planTab === "agent"}
                className={`wstab ${planTab === "agent" ? "wstab--active" : ""}`}
                onClick={() => setPlanTab("agent")}
              >
                {t("plans.agentPlanTab")}
              </button>
            </div>
            <BillingCycleToggle isAnnual={isAnnual} onChange={setIsAnnual} />
          </div>

          {notice && <div className="plans-view__notice">{notice}</div>}

          {error && (
            <div className="plans-view__error">
              <span>{error}</span>
              {(showPortalAction || error) && (
                <button type="button" className="chip chip--small" onClick={openExternalBilling}>
                  {t("plans.openInBrowser")}
                </button>
              )}
            </div>
          )}

          {loading && <div className="plans-view__state">{t("plans.loading")}</div>}

          {!loading && (!plans || plans.length === 0) && (
            <div className="plans-view__state">
              <div>{t("plans.unavailable")}</div>
              <button type="button" className="chip chip--small" style={{ marginTop: 10 }} onClick={() => void load()}>
                {t("plans.retry")}
              </button>
            </div>
          )}

          {!loading && plans && plans.length > 0 && visiblePlans.length === 0 && (
            <div className="plans-view__state">
              {planTab === "agent" ? t("plans.noAgentPlans") : t("plans.noCodingPlans")}
            </div>
          )}

          {!loading && visiblePlans.length > 0 && (
            <div className="plans-grid">
              {visiblePlans.map((plan) => {
                const pres = buildPlanCardPresentation({
                  plan,
                  currentPlanId,
                  currentPlanName,
                  currentPlanPriceMonthly,
                  publicPlans: plans ?? [],
                  hasSubscription,
                  isAnnual,
                  currentBillingCycle: overview?.subscriptionBillingCycle ?? null,
                  isLoading: loadingPlanId === plan.id,
                });
                const bullets = featureLines(plan.features);
                const scheduled = pendingPlanSwitchForCard({
                  planId: plan.id,
                  isCurrent: pres.isCurrent,
                  pendingPlanChange,
                  nextBillingDate,
                });
                const pendingOnCurrent = pendingSwitchOnCurrentPlanCard({
                  isCurrent: pres.isCurrent,
                  pendingPlanChange,
                  nextBillingDate,
                });
                const cancelScheduled = scheduledCancellationForPlanCard({
                  isCurrent: pres.isCurrent,
                  cancelAtPeriodEnd: overview?.cancelAtPeriodEnd ?? false,
                  nextBillingDate,
                  pendingPlanChange,
                });
                const isScheduledTarget = pendingPlanChange?.planId === plan.id;
                 const soldOut = plan.isSoldOut;
 const ctaDisabled =
                    soldOut ||                   pres.cta.disabled || isScheduledTarget || (loadingPlanId !== null && loadingPlanId !== plan.id);

                return (
                  <div
                    key={plan.id}
                    className={`plans-card ${plan.isPopular ? "plans-card--popular" : ""} ${pres.isCurrent ? "plans-card--current" : ""}`}
                  >
                    <div className="plans-card__head">
                      <div className="plans-card__name">{plan.name}</div>
                      <div className="plans-card__badges">
                        {plan.isPopular && <span className="badge badge--ok">{t("plans.popular")}</span>}
 {plan.isSoldOut && <span className="badge badge--muted">{t("plans.soldOut")}</span>}
                        {scheduled && <span className="badge">{t("plans.cta.scheduled")}</span>}
                      </div>
                    </div>
                    <div className="plans-card__price">{formatPlanPrice(plan)}</div>
                    {plan.localizedPrice.amount > 0 && (
                      <div className="plans-card__period">{t("plans.perMonth")}</div>
                    )}
                    {cancelScheduled && (
                      <div className="plans-card__scheduled">
                        {t("plans.scheduled.cancel").replace("{date}", formatBillingDate(cancelScheduled.expiresAt))}
                      </div>
                    )}
                    {pendingOnCurrent && (
                      <div className="plans-card__scheduled">
                        {t("plans.scheduled.switching")
                          .replace("{plan}", pendingOnCurrent.switchingTo)
                          .replace("{date}", formatBillingDate(pendingOnCurrent.expiresAt))}
                      </div>
                    )}
                    {scheduled && (
                      <div className="plans-card__scheduled">
                        {t("plans.scheduled.starts").replace("{label}", scheduled.startsAtLabel)}
                      </div>
                    )}
                    {plan.tagline && <div className="plans-card__tagline">{plan.tagline}</div>}
                    <div className="plans-card__quotas">
                      {plan.requestsPerWeek != null && (
                        <span>
                          {t("plans.requestsPerWeek").replace("{count}", formatQuota(plan.requestsPerWeek))}
                        </span>
                      )}
                      {plan.requestsPerWindow != null && plan.windowHours != null && (
                        <span>
                          {t("plans.requestsPerWindow")
                            .replace("{count}", formatQuota(plan.requestsPerWindow))
                            .replace("{hours}", String(plan.windowHours))}
                        </span>
                      )}
                      {plan.tokensPerWeek != null && (
                        <span>
                          {t("plans.tokensPerWeek").replace("{count}", formatQuota(plan.tokensPerWeek))}
                        </span>
                      )}
                    </div>
                    {bullets.length > 0 && (
                      <ul className="plans-card__features">
                        {bullets.map((line, i) => (
                          <li key={`${plan.id}-${i}`}>{line}</li>
                        ))}
                      </ul>
                    )}
                    <div className="plans-card__foot">
                      <button
                        type="button"
                        className={`btn ${pres.cta.key === "current" || isScheduledTarget ? "btn--outline" : ""}`}
                        disabled={ctaDisabled}
                        onClick={() => handleSelectPlan(plan.id)}
                      >
                        {soldOut
   ? t("plans.soldOut")
   : isScheduledTarget
   ? t("plans.cta.scheduled")
   : t(CTA_KEYS[pres.cta.key] as Parameters<typeof t>[0])}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {step === "checkout" && checkoutUrl && (
        <div className="plans-view__checkout">
          {platform === "desktop" ? (
            createElement("webview", {
              src: checkoutUrl,
              style: { width: "100%", height: "100%" },
              ref: (el: unknown) => {
                webviewRef.current = (el as HTMLElement) ?? null;
              },
            })
          ) : (
            <iframe
              src={checkoutUrl}
              title="Checkout"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation"
              onLoad={(e) => {
                try {
                  const src = (e.target as HTMLIFrameElement).contentWindow?.location.href;
                  if (src && src !== "about:blank") handleCheckoutNav(src);
                } catch {
                  // Cross-origin navigation handled by Stripe redirect back to issuer.
                }
              }}
            />
          )}
        </div>
      )}

      {step === "success" && (
        <div className="plans-view__state plans-view__success">
          <Icon name="check" size={28} />
          <div>{t("plans.success")}</div>
        </div>
      )}

      {downgradeTarget && (
        <PlanDowngradeDialog
          targetPlan={downgradeTarget}
          nextBillingDate={nextBillingDate}
          isLoading={loadingPlanId === downgradeTarget.id}
          onApplyNextCycle={() => void performPlanSelection(downgradeTarget.id, false)}
          onCancel={() => setPendingDowngradePlanId(null)}
        />
      )}

      {crossCurrencyTarget && overview && (
        <CrossCurrencyDialog
          targetPlanName={crossCurrencyTarget.name}
          proratedChargeToday={estimateProratedCharge({
            targetPriceMonthly: crossCurrencyTarget.priceMonthly,
            periodStart: overview.currentPeriodStart,
            nextBillingDate,
          })}
          targetCurrency={crossCurrencyTarget.localizedPrice.currency}
          currentPlanName={currentPlanName ?? t("plans.yourCurrentPlanFallback")}
          currentCurrency={subscriptionCurrency ?? "usd"}
          refundEstimate={estimateRefund({
            latestInvoiceAmountPaid: overview.latestInvoiceAmountPaid,
            latestInvoiceCurrency: overview.latestInvoiceCurrency,
            periodStart: overview.currentPeriodStart,
            nextBillingDate,
          })}
          nextBillingDate={nextBillingDate}
          isDowngrade={isPlanDowngrade({
            hasSubscription,
            targetPlan: crossCurrencyTarget,
            currentPlanId,
            currentPlanPriceMonthly,
            publicPlans: plans ?? [],
          })}
          isLoading={loadingPlanId === crossCurrencyTarget.id}
          onApplyNow={confirmCrossCurrencyNow}
          onApplyNextCycle={confirmCrossCurrencyNextCycle}
          onCancel={() => setPendingCrossCurrencyPlanId(null)}
        />
      )}

      {pendingPurchase && (
        <PurchaseAgreementDialog
          planName={pendingPurchase.planName}
          displayPrice={pendingPurchase.displayPrice}
          currency={pendingPurchase.currency}
          isAnnual={isAnnual}
          isLoading={loadingPlanId === pendingPurchase.selectionPlanId}
          onConfirm={confirmPurchase}
          onCancel={() => setPendingPurchase(null)}
        />
      )}
    </div>
  );
}
