import type { ReactNode } from "react";

/** Inline monospace pill for paths, env vars, tool names, file:line refs. */
export function CodeTag(props: { children: ReactNode; className?: string; title?: string }) {
  return (
    <code className={`ui-code-tag${props.className ? ` ${props.className}` : ""}`} title={props.title}>
      {props.children}
    </code>
  );
}
