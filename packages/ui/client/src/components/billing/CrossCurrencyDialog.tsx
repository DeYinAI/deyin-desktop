import { useT } from "../../i18n.js";

interface CrossCurrencyDialogProps {
  targetPlanName: string;
  proratedChargeToday: number;
  targetCurrency: string;
  currentPlanName: string;
  currentCurrency: string;
  refundEstimate: number | null;
  nextBillingDate: string | null;
  isDowngrade: boolean;
  isLoading: boolean;
  onApplyNow: () => void;
  onApplyNextCycle: () => void;
  onCancel: () => void;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
  }
}

export function CrossCurrencyDialog({
  targetPlanName,
  proratedChargeToday,
  targetCurrency,
  currentPlanName,
  currentCurrency,
  refundEstimate,
  nextBillingDate,
  isDowngrade,
  isLoading,
  onApplyNow,
  onApplyNextCycle,
  onCancel,
}: CrossCurrencyDialogProps) {
  const t = useT();
  const periodLabel = nextBillingDate ?? t("plans.downgrade.nextPlanStartsNextCycle");
  const chargeLabel = formatMoney(proratedChargeToday, targetCurrency);
  const refundLabel = refundEstimate != null ? formatMoney(refundEstimate, currentCurrency) : null;

  return (
    <div className="plans-view__dialog-overlay" role="dialog" aria-modal="true">
      <div className="plans-view__dialog plans-view__dialog--wide">
        <div className="plans-view__dialog-title">
          {isDowngrade
            ? t("plans.crossCurrency.headingDowngrade")
                .replace("{currency}", currentCurrency.toUpperCase())
                .replace("{plan}", targetPlanName)
                .replace("{date}", periodLabel)
            : t("plans.crossCurrency.headingUpgrade")
                .replace("{currency}", currentCurrency.toUpperCase())
                .replace("{plan}", targetPlanName)
                .replace("{date}", periodLabel)}
        </div>

        {!isDowngrade && (
          <div className="plans-view__dialog-option">
            <div className="plans-view__dialog-option-title">{t("plans.crossCurrency.upgradeNowTitle")}</div>
            <p className="plans-view__dialog-desc">
              {refundLabel
                ? t("plans.crossCurrency.refundAndCharge")
                    .replace("{refund}", refundLabel)
                    .replace("{charge}", chargeLabel)
                : t("plans.crossCurrency.chargeOnly").replace("{charge}", chargeLabel)}{" "}
              {t("plans.crossCurrency.startsImmediately")
                .replace("{plan}", targetPlanName)
                .replace("{date}", periodLabel)}
            </p>
            <button type="button" className="btn" disabled={isLoading} onClick={onApplyNow}>
              {isLoading ? t("plans.processing") : t("plans.crossCurrency.upgradeNow")}
            </button>
          </div>
        )}

        <div className="plans-view__dialog-option">
          <div className="plans-view__dialog-option-title">
            {isDowngrade ? t("plans.crossCurrency.switchAtNextBillingDate") : t("plans.crossCurrency.upgradeAtNextTitle")}
          </div>
          <p className="plans-view__dialog-desc">
            {t("plans.crossCurrency.noChargeToday")
              .replace("{current}", currentPlanName)
              .replace("{target}", targetPlanName)
              .replace("{date}", periodLabel)}
          </p>
          <button
            type="button"
            className={`btn ${isDowngrade ? "" : "btn--outline"}`}
            disabled={isLoading}
            onClick={onApplyNextCycle}
          >
            {isLoading ? t("plans.processing") : t("plans.crossCurrency.switchAtNextBillingDate")}
          </button>
        </div>

        <div className="plans-view__dialog-actions">
          <button type="button" className="btn btn--outline" disabled={isLoading} onClick={onCancel}>
            {t("plans.common.goBack")}
          </button>
        </div>

        {!isDowngrade && (
          <p className="plans-view__dialog-hint">{t("plans.crossCurrency.estimatesNote")}</p>
        )}
      </div>
    </div>
  );
}
