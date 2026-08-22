import type { ReactNode } from "react";

/** Dot-separated monospace metadata line: "HYRAX-329 · src/lib/env.ts:42 · Low risk". */
export function MetaRow(props: { items: ReactNode[]; className?: string }) {
  const items = props.items.filter((v) => v !== undefined && v !== null && v !== "");
  if (items.length === 0) return null;
  return (
    <div className={`ui-meta-row${props.className ? ` ${props.className}` : ""}`}>
      {items.map((item, i) => (
        <span key={i} className="ui-meta-row__item">
          {item}
          {i < items.length - 1 && <span className="ui-meta-row__dot">·</span>}
        </span>
      ))}
    </div>
  );
}
