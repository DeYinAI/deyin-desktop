import { useEffect } from "react";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";

interface Props {
  title: string;
  overview?: string;
  onApprove: () => void;
  /** Keep the plan, hand the turn back to the composer for written feedback. */
  onRevise: () => void;
  /** Dismiss the gate without acting; the plan stays buildable from the Plan tab. */
  onDismiss: () => void;
  onEdit?: () => void;
}

/**
 * The gate that follows a finished plan: one question, numbered answers, in the
 * composer stack. Shares the geometry and keys of AskQuestionDialog — 1 accepts,
 * 2 sends the turn back for feedback, Escape dismisses.
 */
export function PlanApprovalDialog({ title, overview, onApprove, onRevise, onDismiss, onEdit }: Props) {
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onDismiss();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "1") {
        e.preventDefault();
        onApprove();
      } else if (e.key === "2") {
        e.preventDefault();
        onRevise();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onApprove, onDismiss, onRevise]);

  return (
    <div className="askq askq--gate" role="group" aria-label={t("plan.gate.question")}>
      <div className="askq__head">
        <div className="askq__prompt">
          {t("plan.gate.question")}
          <span className="askq__prompt-sub" title={overview || title}>
            {title}
          </span>
        </div>
        <button type="button" className="askq__close" aria-label={t("plan.gate.dismiss")} onClick={onDismiss}>
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className="askq__options">
        <button type="button" className="askq__option" onClick={onApprove}>
          <span className="askq__index">1</span>
          <span className="askq__body">
            <span className="askq__label">{t("plan.gate.yes")}</span>
          </span>
          <Icon name="arrowRight" size={13} className="askq__go" />
        </button>
        <button type="button" className="askq__option" onClick={onRevise}>
          <span className="askq__index askq__index--glyph">
            <Icon name="pencil" size={11} />
          </span>
          <span className="askq__body">
            <span className="askq__label">{t("plan.gate.no")}</span>
          </span>
          <Icon name="arrowRight" size={13} className="askq__go" />
        </button>
      </div>

      <div className="askq__foot">
        {onEdit && (
          <button type="button" className="askq__other" onClick={onEdit}>
            <Icon name="file" size={11} />
            {t("plan.gate.editFile")}
          </button>
        )}
        <div className="askq__actions">
          <button type="button" className="btn btn--pill btn--ghost askq__skip" onClick={onDismiss}>
            {t("plan.gate.skip")}
          </button>
        </div>
      </div>
    </div>
  );
}
