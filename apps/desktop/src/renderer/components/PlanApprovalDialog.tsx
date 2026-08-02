import { Icon } from "./Icon.js";

interface Props {
  title: string;
  overview?: string;
  onApprove: () => void;
  onReject: () => void;
  onEdit?: () => void;
}

/** Inline prompt shown when a plan artifact is ready for user approval. */
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
            <button type="button" className="btn btn--outline btn--small" onClick={onReject}>
              Revise
            </button>
            {onEdit && (
              <button type="button" className="btn btn--outline btn--small" onClick={onEdit}>
                Edit
              </button>
            )}
          </div>
          <button type="button" className="btn btn--primary" onClick={onApprove}>
            <Icon name="play" size={12} />
            Build
          </button>
        </div>
      </div>
    </div>
  );
}
