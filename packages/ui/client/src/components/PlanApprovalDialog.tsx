import { Icon } from "./Icon.js";

interface Props {
  title: string;
  overview?: string;
  onApprove: () => void;
  onReject: () => void;
  onEdit?: () => void;
}

/** Inline gate shown above the composer when a plan artifact is ready for approval. */
export function PlanApprovalDialog({ title, overview, onApprove, onReject, onEdit }: Props) {
  return (
    <div className="plan-approval-inline">
      <div className="plan-approval-inline__box">
        <div className="plan-approval-inline__title">
          <Icon name="file" size={15} />
          Plan ready: {title}
        </div>
        {overview && <div className="plan-approval-inline__summary">{overview}</div>}
        <div className="plan-approval-inline__actions">
          <div className="plan-approval-inline__actions-left">
            <button type="button" className="btn btn--outline" onClick={onReject}>
              Revise
            </button>
            {onEdit && (
              <button type="button" className="btn btn--outline" onClick={onEdit}>
                Edit plan
              </button>
            )}
          </div>
          <button type="button" className="btn btn--primary" onClick={onApprove}>
            <Icon name="play" size={11} />
            Build
          </button>
        </div>
      </div>
    </div>
  );
}
