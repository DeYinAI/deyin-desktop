import { Icon } from "./Icon.js";

interface Props {
  title: string;
  overview?: string;
  onApprove: () => void;
  onReject: () => void;
  onEdit?: () => void;
}

/** Modal gate shown when a plan artifact is ready for user approval. */
export function PlanApprovalDialog({ title, overview, onApprove, onReject, onEdit }: Props) {
  return (
    <div className="approval plan-approval" role="dialog" aria-modal="true">
      <div className="approval__box plan-approval__box">
        <div className="approval__title">
          <Icon name="file" size={15} />
          Plan ready: {title}
        </div>
        {overview && <div className="approval__summary">{overview}</div>}
        <div className="approval__actions">
          <button type="button" className="btn btn--outline" onClick={onReject}>
            Revise
          </button>
          {onEdit && (
            <button type="button" className="btn btn--outline" onClick={onEdit}>
              Edit
            </button>
          )}
          <button type="button" className="btn" onClick={onApprove}>
            <Icon name="play" size={11} />
            Build
          </button>
        </div>
      </div>
    </div>
  );
}
