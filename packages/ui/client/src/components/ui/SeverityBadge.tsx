import type { ReactNode } from "react";

/** Bordered uppercase severity pill — text + border, not filled. */
export type SeverityLevel = "critical" | "high" | "medium" | "low" | "info";

export function SeverityBadge(props: { level: SeverityLevel; children?: ReactNode; className?: string }) {
  return (
    <span className={`ui-sev ui-sev--${props.level}${props.className ? ` ${props.className}` : ""}`}>
      {props.children ?? props.level}
    </span>
  );
}
