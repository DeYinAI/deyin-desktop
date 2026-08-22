import type { ReactNode } from "react";

/** Neutral by default; `tone` tints the border and text for warnings/errors. */
export type CalloutTone = "muted" | "good" | "warn" | "bad";

/** Inset bordered info box for summaries, notes, and tool output. */
export function Callout(props: { children: ReactNode; className?: string; mono?: boolean; tone?: CalloutTone }) {
  const tone = props.tone && props.tone !== "muted" ? ` ui-callout--${props.tone}` : "";
  return (
    <div
      className={`ui-callout${props.mono ? " ui-callout--mono" : ""}${tone}${props.className ? ` ${props.className}` : ""}`}
    >
      {props.children}
    </div>
  );
}
