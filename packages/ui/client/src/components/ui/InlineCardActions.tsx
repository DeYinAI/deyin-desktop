import type { ReactNode } from "react";

/** Primary cream CTA + secondary buttons; supports left/right split layout. */
export function InlineCardActions(props: {
  children: ReactNode;
  /** Left-aligned secondary group (e.g. Revise / Edit). */
  left?: ReactNode;
  between?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`ui-card-actions${props.between ? " ui-card-actions--between" : ""}${props.className ? ` ${props.className}` : ""}`}
    >
      {props.left && <div style={{ display: "flex", gap: 8 }}>{props.left}</div>}
      <div style={{ display: "flex", gap: 8 }}>{props.children}</div>
    </div>
  );
}
