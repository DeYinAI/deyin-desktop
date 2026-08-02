import { formatBillingDate } from "@deyin/host-core/shared";
import { useT } from "../../i18n.js";
import type { PublicPlan } from "../../../shared/types.js";

interface PlanDowngradeDialogProps {
  targetPlan: PublicPlan;
  nextBillingDate: string | null;
  isLoading: boolean;
  onApplyNextCycle: () => void;
  onCancel: () => void;
}

export function PlanDowngradeDialog({
  targetPlan,
  nextBillingDate,
  isLoading,
  onApplyNextCycle,
  onCancel,
}: PlanDowngradeDialogProps) {
  const t = useT();
  const periodLabel = nextBillingDate
    ? formatBillingDate(nextBillingDate)
    : t("plans.downgrade.planEndsNextCycle");
  const isFreeTarget = targetPlan.priceMonthly === 0;

  return (
    <div className="plans-view__dialog-overlay" role="dialog" aria-modal="true">
      <div className="plans-view__dialog">
        {isFreeTarget ? (
          <>
            <div className="plans-view__dialog-title">
              {nextBillingDate
                ? t("plans.downgrade.planEnds").replace("{date}", periodLabel)
                : t("plans.downgrade.planEndsNextCycle")}
            </div>
            <p className="plans-view__dialog-desc">
              {t("plans.downgrade.cancelAndSwitchToFree").replace(/<\/?strong>/g, "")}
            </p>
            <p className="plans-view__dialog-hint">{t("plans.downgrade.keepPlanUntilThen")}</p>
            <div className="plans-view__dialog-actions">
              <button type="button" className="btn" disabled={isLoading} onClick={onApplyNextCycle}>
                {isLoading ? t("plans.processing") : t("plans.downgrade.scheduleCancellation")}
              </button>
              <button type="button" className="btn btn--outline" disabled={isLoading} onClick={onCancel}>
                {t("plans.common.goBack")}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="plans-view__dialog-title">
              {nextBillingDate
                ? t("plans.downgrade.nextPlanStarts").replace("{date}", periodLabel)
                : t("plans.downgrade.nextPlanStartsNextCycle")}
            </div>
            <p className="plans-view__dialog-desc">
              {t("plans.downgrade.switchAtNextCycle").replace("{plan}", targetPlan.name).replace(/<\/?strong>/g, "")}
            </p>
            <div className="plans-view__dialog-actions">
              <button type="button" className="btn" disabled={isLoading} onClick={onApplyNextCycle}>
                {isLoading ? t("plans.processing") : t("plans.downgrade.applyAtNextCycle")}
              </button>
              <button type="button" className="btn btn--outline" disabled={isLoading} onClick={onCancel}>
                {t("plans.common.cancel")}
              </button>
            </div>
            <p className="plans-view__dialog-hint">
              {t("plans.downgrade.staysActiveUntil").replace("{date}", periodLabel)}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
