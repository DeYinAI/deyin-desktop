import { useCallback, useEffect, useRef, useState } from "react";
import { formatPlanPrice, formatQuota } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";
import type { AccountUsage, PublicPlan } from "../../shared/types.js";

interface PlansDialogProps {
  platform: "desktop" | "web";
  oauthIssuer: string;
  userPlan: string | null;
  onClose: () => void;
}

function featureLines(features: string | null): string[] {
  if (!features?.trim()) return [];
  return features.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function fetchPlans(): Promise<[PublicPlan[], AccountUsage | null]> {
  const [catalog, usage] = await Promise.all([
    window.deyin.plans.list(),
    window.deyin.usage.account(true).catch(() => null),
  ]);
  return [catalog, usage];
}

export function PlansDialog({ platform, oauthIssuer, userPlan, onClose }: PlansDialogProps) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);
  const [account, setAccount] = useState<AccountUsage | null>(null);
  const [loading, setLoading] = useState(true);

  // Escape/backdrop can close the dialog mid-fetch (initial load or Retry); both
  // paths check this before touching state so we never setState after unmount.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [catalog, usage] = await fetchPlans();
      if (!mountedRef.current) return;
      setPlans(catalog);
      setAccount(usage);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);

  const upgradeUrl = `${oauthIssuer.replace(/\/$/, "")}/app/user/billing/upgrade`;

  const openUpgrade = () => {
    if (platform === "desktop") window.deyin.shell.openExternal(upgradeUrl);
    else window.open(upgradeUrl, "_blank", "noopener");
  };

  const currentPlanName =
    account?.planName?.trim().toLowerCase() ?? userPlan?.trim().toLowerCase() ?? null;

  const isCurrent = (plan: PublicPlan) =>
    currentPlanName !== null && plan.name.trim().toLowerCase() === currentPlanName;

  return (
    <div className="plans-overlay" role="dialog" aria-modal="true" aria-labelledby="plans-dialog-title">
      <div className="plans-dialog" ref={boxRef}>
        <div className="plans-dialog__head">
          <div>
            <div className="plans-dialog__title" id="plans-dialog-title">
              {t("plans.title")}
            </div>
            <div className="plans-dialog__desc">{t("plans.subtitle")}</div>
          </div>
          <span className="plans-dialog__spacer" />
          <button type="button" className="icon-btn" title="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="plans-dialog__body">
          {loading && <div className="plans-dialog__state">{t("plans.loading")}</div>}

          {!loading && (!plans || plans.length === 0) && (
            <div className="plans-dialog__state">
              <div>{t("plans.unavailable")}</div>
              <button type="button" className="chip chip--small" style={{ marginTop: 10 }} onClick={() => void load()}>
                {t("plans.retry")}
              </button>
            </div>
          )}

          {!loading && plans && plans.length > 0 && (
            <div className="plans-grid">
              {plans.map((plan) => {
                const current = isCurrent(plan);
                const bullets = featureLines(plan.features);
                return (
                  <div
                    key={plan.id}
                    className={`plans-card ${plan.isPopular ? "plans-card--popular" : ""} ${current ? "plans-card--current" : ""}`}
                  >
                    <div className="plans-card__head">
                      <div className="plans-card__name">{plan.name}</div>
                      {plan.isPopular && <span className="badge badge--ok">{t("plans.popular")}</span>}
                    </div>
                    <div className="plans-card__price">{formatPlanPrice(plan)}</div>
                    {plan.localizedPrice.amount > 0 && (
                      <div className="plans-card__period">{t("plans.perMonth")}</div>
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
                      {current ? (
                        <button type="button" className="btn btn--outline" disabled>
                          {t("plans.current")}
                        </button>
                      ) : (
                        <button type="button" className="btn" onClick={openUpgrade}>
                          {t("plans.upgrade")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
