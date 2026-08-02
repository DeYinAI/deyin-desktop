import { useT } from "../../i18n.js";

interface BillingCycleToggleProps {
  isAnnual: boolean;
  onChange: (annual: boolean) => void;
}

export function BillingCycleToggle({ isAnnual, onChange }: BillingCycleToggleProps) {
  const t = useT();
  return (
    <div className="plans-view__cycle-toggle" role="group" aria-label="Billing cycle">
      <button
        type="button"
        className={`plans-view__cycle-btn ${!isAnnual ? "plans-view__cycle-btn--active" : ""}`}
        onClick={() => onChange(false)}
      >
        {t("plans.annualToggle.monthly")}
      </button>
      <button
        type="button"
        className={`plans-view__cycle-btn ${isAnnual ? "plans-view__cycle-btn--active" : ""}`}
        onClick={() => onChange(true)}
      >
        {t("plans.annualToggle.annual")}
      </button>
    </div>
  );
}
