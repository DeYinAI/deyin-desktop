import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  annualMonthsFree,
  annualSavingPercent,
  buildPlanColumns,
  buildPlanCardPresentation,
  estimateProratedCharge,
  estimateRefund,
  formatBillingDate,
  formatCurrencyAmount,
  formatReleaseCountdown,
  getPlanCardPricing,
  getPlanComparisonRows,
  getPlanDisplayFeatures,
  getPlanTagline,
  hasActiveSubscription,
  isAllowedCheckoutUrl,
  isCheckoutCanceledUrl,
  isCheckoutSuccessUrl,
  isCrossCurrencyChange,
  isPlanDowngrade,
  isPlanPurchaseBlocked,
  pendingPlanSwitchForCard,
  pendingSwitchOnCurrentPlanCard,
  planBlockedCtaKind,
  releaseAnyBlocked,
  scheduledCancellationForPlanCard,
  type BillingOverview,
  type PlanCardCtaKey,
  type PublicPlan,
  type ReleaseStatus,
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

/** The issuer answers 403 with this when the token predates the billing scope. */
function isBillingScopeError(message: string): boolean {
  return /session login required/i.test(message);
}

export function PlansView({ platform, oauthIssuer, userPlan, onBack, onComplete }: PlansViewProps) {
  const t = useT();
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);
  const [overview, setOverview] = useState<BillingOverview | null>(null);
  const [release, setRelease] = useState<ReleaseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [planTab, setPlanTab] = useState<PlanTab>("coding");
  const [isAnnual, setIsAnnual] = useState(false);
  const [step, setStep] = useState<Step>("select");
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [loadingPlanId, setLoadingPlanId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPortalAction, setShowPortalAction] = useState(false);
  const [showSignInAction, setShowSignInAction] = useState(false);
  const [showComparison, setShowComparison] = useState(false);
  /** Per-column tier choice (Pro vs Pro+), keyed by column key. */
  const [tierChoice, setTierChoice] = useState<Record<string, number>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
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

  const refreshRelease = useCallback(async () => {
    const status = await window.deyin.plans.releaseStatus();
    if (mountedRef.current) setRelease(status);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [catalog, billing, releaseStatus] = await Promise.all([
        window.deyin.plans.list(),
        window.deyin.billing.overview(),
        window.deyin.plans.releaseStatus(),
      ]);
      if (!mountedRef.current) return;
      setPlans(catalog);
      setOverview(billing);
      setRelease(releaseStatus);
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
  /** Paying subscribers bypass the daily release gate, as they do server-side. */
  const releaseExempt = hasSubscription && (currentPlanPriceMonthly ?? 0) > 0;

  const countdown = formatReleaseCountdown(release?.nextDropAt ?? null, nowMs);
  const anyBlocked = releaseAnyBlocked(release) && !releaseExempt;

  // Tick only while a countdown is actually on screen, and refetch once it
  // runs out — the drop instant has passed, so the sold-out set has moved.
  useEffect(() => {
    if (!anyBlocked || !release?.nextDropAt) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyBlocked, release?.nextDropAt]);

  useEffect(() => {
    if (!anyBlocked || !release?.nextDropAt || countdown !== null) return;
    void refreshRelease();
  }, [anyBlocked, countdown, refreshRelease, release?.nextDropAt]);

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

  // Coding tiers collapse into the pricing page's columns (Pro/Pro+ and
  // Max/Max+ share a card); agent SKUs stay one card each.
  const columns = useMemo(
    () =>
      planTab === "agent"
        ? visiblePlans.map((p) => ({ key: p.name, tiers: [p] }))
        : buildPlanColumns(visiblePlans),
    [planTab, visiblePlans],
  );

  const activeTierOf = useCallback(
    (column: { key: string; tiers: PublicPlan[] }): PublicPlan => {
      const chosen = column.tiers.find((p) => p.id === tierChoice[column.key]);
      if (chosen) return chosen;
      const current = column.tiers.find((p) => p.id === currentPlanId);
      return current ?? (column.tiers[0] as PublicPlan);
    },
    [currentPlanId, tierChoice],
  );

  const comparisonPlans = useMemo(
    () => columns.map((column) => activeTierOf(column)),
    [activeTierOf, columns],
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
      setShowSignInAction(false);
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
        // A token minted before `billing:manage` existed still authenticates,
        // so the issuer rejects the call rather than the sign-in. Re-consent
        // is the fix; the browser page works either way.
        if (isBillingScopeError(msg)) {
          setError(t("plans.billingScopeMissing"));
          setShowSignInAction(true);
          setShowPortalAction(true);
        } else {
          setError(msg);
          const fallback = (err as { fallback?: string }).fallback;
          setShowPortalAction(!!fallback || /portal|billing portal/i.test(msg));
        }
        // The gate may have closed while the card was on screen.
        void refreshRelease();
      } finally {
        setLoadingPlanId(null);
      }
    },
    [hasSubscription, isAnnual, oauthIssuer, onComplete, plans, refreshOverview, refreshRelease, t],
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
        const pricing = getPlanCardPricing(targetPlan, isAnnual);
        setPendingPurchase({
          selectionPlanId: pres.selectionPlanId,
          planName: targetPlan.name,
          displayPrice: pricing.displayPrice,
          currency: pricing.currency,
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
    const pricing = getPlanCardPricing(target, isAnnual);
    setPendingCrossCurrencyPlanId(null);
    setPendingPurchase({
      selectionPlanId: pres.selectionPlanId,
      planName: target.name,
      displayPrice: pricing.displayPrice,
      currency: pricing.currency,
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

  const releaseBanner = (() => {
    if (!anyBlocked || !release) return null;
    if (!release.available) return t("plans.release.unavailableBanner");
    if (release.beforeDrop) return t("plans.release.beforeDropBanner");
    return t("plans.release.soldOutBanner");
  })();

  const comparisonRows = showComparison ? getPlanComparisonRows(comparisonPlans) : [];

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
            <div className="plans-view__cycle">
              <BillingCycleToggle isAnnual={isAnnual} onChange={setIsAnnual} />
              <span className="plans-view__save-chip">
                {t("plans.annualToggle.save").replace("{percent}", String(annualSavingPercent()))}
              </span>
            </div>
          </div>

          {releaseBanner && (
            <div className="plans-view__release-banner">
              <span>{releaseBanner}</span>
              {countdown && (
                <span className="plans-view__release-countdown">
                  {t("plans.releaseCountdown").replace("{countdown}", countdown)}
                </span>
              )}
            </div>
          )}

          {notice && <div className="plans-view__notice">{notice}</div>}

          {error && (
            <div className="plans-view__error">
              <span>{error}</span>
              {showSignInAction && (
                <button type="button" className="chip chip--small" onClick={() => void window.deyin.auth.connect()}>
                  {t("plans.signInAgain")}
                </button>
              )}
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

          {!loading && plans && plans.length > 0 && columns.length === 0 && (
            <div className="plans-view__state">
              {planTab === "agent" ? t("plans.noAgentPlans") : t("plans.noCodingPlans")}
            </div>
          )}

          {!loading && columns.length > 0 && (
            <div className="plans-grid">
              {columns.map((column) => {
                const plan = activeTierOf(column);
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
                const pricing = getPlanCardPricing(plan, isAnnual);
                const tagline = getPlanTagline(plan);
                const bullets = getPlanDisplayFeatures(plan, "marketing");
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
                const blockedParams = {
                  releaseStatus: release,
                  planId: plan.id,
                  planPriceMonthly: plan.priceMonthly,
                  isAnnual,
                  // The gate only ever closes NEW purchases, so the card for
                  // the plan already held must keep its own CTA.
                  releaseExempt: releaseExempt || pres.isCurrent,
                };
                const blocked = isPlanPurchaseBlocked(blockedParams);
                const blockedKind = planBlockedCtaKind(blockedParams);
                const ctaDisabled =
                  blocked ||
                  pres.cta.disabled ||
                  isScheduledTarget ||
                  (loadingPlanId !== null && loadingPlanId !== plan.id);

                return (
                  <div
                    key={column.key}
                    className={`plans-card ${plan.isPopular ? "plans-card--popular" : ""} ${pres.isCurrent ? "plans-card--current" : ""}`}
                  >
                    {plan.isPopular && <div className="plans-card__ribbon">{t("plans.popular")}</div>}
                    <div className="plans-card__head">
                      {column.tiers.length > 1 ? (
                        <div className="plans-card__tiers" role="group">
                          {column.tiers.map((tier) => (
                            <button
                              key={tier.id}
                              type="button"
                              aria-pressed={tier.id === plan.id}
                              className={`plans-card__tier ${tier.id === plan.id ? "plans-card__tier--active" : ""}`}
                              onClick={() => setTierChoice((prev) => ({ ...prev, [column.key]: tier.id }))}
                            >
                              {tier.name}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="plans-card__name">{plan.name}</div>
                      )}
                      <div className="plans-card__badges">
                        {blocked && blockedKind === "soldOut" && (
                          <span className="badge badge--muted">{t("plans.soldOut")}</span>
                        )}
                        {scheduled && <span className="badge">{t("plans.cta.scheduled")}</span>}
                      </div>
                    </div>

                    {tagline && <div className="plans-card__tagline">{tagline}</div>}

                    <div className="plans-card__price-row">
                      <span className="plans-card__price">
                        {formatCurrencyAmount(pricing.displayPrice, pricing.currency)}
                      </span>
                      {pricing.displayPrice > 0 && (
                        <span className="plans-card__period">{t("plans.perMonth")}</span>
                      )}
                    </div>
                    {pricing.billedYearly != null && (
                      <div className="plans-card__billed">
                        {t("plans.billedYearly")
                          .replace("{price}", formatCurrencyAmount(pricing.billedYearly, pricing.currency))
                          .replace("{months}", String(annualMonthsFree()))}
                      </div>
                    )}
                    {plan.maxRpm > 0 && (
                      <div className="plans-card__rpm">
                        {t("plans.rpm").replace("{count}", String(plan.maxRpm))}
                      </div>
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

                    {bullets.length > 0 && (
                      <ul className="plans-card__features">
                        {bullets.map((line, i) => (
                          <li key={`${plan.id}-${i}`}>
                            <Icon name="check" size={12} />
                            <span>{line}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="plans-card__foot">
                      <button
                        type="button"
                        className={`btn ${pres.cta.key === "current" || isScheduledTarget || blocked ? "btn--outline" : ""}`}
                        disabled={ctaDisabled}
                        onClick={() => handleSelectPlan(plan.id)}
                      >
                        {blocked
                          ? blockedKind === "unavailable"
                            ? t("plans.releaseUnavailable")
                            : blockedKind === "beforeDrop"
                              ? t("plans.availableAt").replace(
                                  "{hour}",
                                  String(release?.dropHourUtc ?? 0).padStart(2, "0"),
                                )
                              : t("plans.soldOut")
                          : isScheduledTarget
                            ? t("plans.cta.scheduled")
                            : t(CTA_KEYS[pres.cta.key] as Parameters<typeof t>[0])}
                      </button>
                      {blocked && countdown && (
                        <div className="plans-card__countdown">
                          {t("plans.releaseCountdown").replace("{countdown}", countdown)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!loading && comparisonPlans.length > 1 && (
            <div className="plans-view__compare">
              <button
                type="button"
                className="plans-view__compare-toggle"
                aria-expanded={showComparison}
                onClick={() => setShowComparison((v) => !v)}
              >
                {showComparison ? t("plans.hideComparison") : t("plans.compareAll")}
              </button>
              {showComparison && (
                <div className="plans-view__compare-scroll">
                  <table className="plans-compare">
                    <thead>
                      <tr>
                        <th scope="col" />
                        {comparisonPlans.map((plan) => (
                          <th key={plan.id} scope="col">
                            {plan.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {comparisonRows.map((row) => (
                        <tr key={row.label} className={row.highlight ? "plans-compare__row--highlight" : ""}>
                          <th scope="row">{row.label}</th>
                          {row.values.map((value, i) => (
                            <td key={`${row.label}-${comparisonPlans[i]?.id ?? i}`}>
                              {typeof value === "boolean" ? (
                                value ? (
                                  <Icon name="check" size={12} />
                                ) : (
                                  <span className="plans-compare__no">—</span>
                                )
                              ) : (
                                value
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
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
