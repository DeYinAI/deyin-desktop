import { useEffect, useState } from "react";
import { formatCurrencyAmount } from "@deyin/host-core/shared";
import { useT } from "../../i18n.js";

interface PurchaseAgreementDialogProps {
  planName: string;
  displayPrice: number;
  currency: string;
  isAnnual: boolean;
  isLoading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PurchaseAgreementDialog({
  planName,
  displayPrice,
  currency,
  isAnnual,
  isLoading,
  onConfirm,
  onCancel,
}: PurchaseAgreementDialogProps) {
  const t = useT();
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [agreedNoRefunds, setAgreedNoRefunds] = useState(false);

  useEffect(() => {
    setAgreedTerms(false);
    setAgreedNoRefunds(false);
  }, [planName]);

  const priceLabel =
    displayPrice > 0
      ? t("plans.agreement.pricePerMonth").replace(
          "{price}",
          formatCurrencyAmount(displayPrice, currency),
        )
      : "";

  const canContinue = agreedTerms && agreedNoRefunds;

  return (
    <div className="plans-view__dialog-overlay" role="dialog" aria-modal="true">
      <div className="plans-view__dialog">
        <div className="plans-view__dialog-title">{t("plans.agreement.title")}</div>
        <p className="plans-view__dialog-desc">{t("plans.agreement.desc")}</p>
        <div className="plans-view__dialog-plan">
          <strong>{planName}</strong>
          {priceLabel && <span>{priceLabel}{isAnnual ? ` (${t("plans.annualToggle.annual")})` : ""}</span>}
        </div>
        <label className="plans-view__dialog-check">
          <input type="checkbox" checked={agreedTerms} onChange={(e) => setAgreedTerms(e.target.checked)} />
          <span>{t("plans.agreement.terms")}</span>
        </label>
        <label className="plans-view__dialog-check">
          <input type="checkbox" checked={agreedNoRefunds} onChange={(e) => setAgreedNoRefunds(e.target.checked)} />
          <span>{t("plans.agreement.noRefunds")}</span>
        </label>
        <div className="plans-view__dialog-actions">
          <button type="button" className="btn" disabled={!canContinue || isLoading} onClick={onConfirm}>
            {isLoading ? t("plans.processing") : t("plans.agreement.continue")}
          </button>
          <button type="button" className="btn btn--outline" disabled={isLoading} onClick={onCancel}>
            {t("plans.agreement.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
