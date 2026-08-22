import { Icon } from "./Icon.js";
import { CodeTag, FindingRow } from "./ui/index.js";
import type { PendingChange, SecurityFinding } from "@deyin/contract";

interface ReviewBannerProps {
  changes: PendingChange[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onApproveAll: () => void;
  onRejectAll: () => void;
  /** High/critical security findings shown when change review is enabled. */
  securityFindings?: SecurityFinding[];
  onOpenSecurity?: () => void;
}

/** Persistent banner when file changes await review (LobeHub-style global approval). */
export function ReviewBanner(props: ReviewBannerProps) {
  const hasSecurity = (props.securityFindings?.length ?? 0) > 0;
  if (props.changes.length === 0 && !hasSecurity) return null;
  return (
    <div className="review-banner" role="region" aria-label="Change review">
      <span className="sr-only" role="status" aria-live="polite">
        {props.changes.length} change{props.changes.length === 1 ? "" : "s"} awaiting review
      </span>
      {hasSecurity && (
        <FindingRow
          severity={topSeverity(props.securityFindings!)}
          title={`${props.securityFindings!.length} high-severity security finding${props.securityFindings!.length === 1 ? "" : "s"}`}
          actions={
            props.onOpenSecurity && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={props.onOpenSecurity}>
                View
              </button>
            )
          }
        />
      )}
      {props.changes.length > 0 && (
        <>
          <div className="review-banner__head">
            <Icon name="hand" size={14} />
            <span>
              {props.changes.length} change{props.changes.length === 1 ? "" : "s"} awaiting review
            </span>
            <div className="review-banner__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={props.onApproveAll}>
                Accept all
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={props.onRejectAll}>
                Reject all
              </button>
            </div>
          </div>
          <ul className="review-banner__list">
            {props.changes.map((c) => (
              <li key={c.id}>
                <FindingRow
                  title={<CodeTag>{c.path.split(/[\\/]/).pop() ?? c.path}</CodeTag>}
                  meta={[c.tool]}
                  actions={
                    <>
                      <button type="button" className="btn btn--primary btn--sm" onClick={() => props.onApprove(c.id)}>
                        Accept
                      </button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => props.onReject(c.id)}>
                        Reject
                      </button>
                    </>
                  }
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function topSeverity(findings: SecurityFinding[]): "critical" | "high" {
  return findings.some((f) => f.severity === "critical") ? "critical" : "high";
}
