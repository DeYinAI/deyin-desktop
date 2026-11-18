import type { ThreadEvent } from "@deyin/contract";

interface SessionStatusLineProps {
  events: ThreadEvent[];
  /** Live token counters for the session. */
  tokenStats?: { sessionTotal: number } | null;
  /** Session prefix cache hit rate (0–1), when measured. */
  cacheHitRate?: number | null;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Caption row under the composer: turns, steps, tokens and prefix-cache hit rate. */
export function SessionStatusLine(props: SessionStatusLineProps) {
  const turns = props.events.filter((e) => e.kind === "user").length;
  const steps = props.events.filter((e) => e.kind === "tool").length;
  if (turns === 0) return null;

  const parts: string[] = [`${turns} ${turns === 1 ? "turn" : "turns"}`];
  if (steps > 0) parts.push(`${steps} ${steps === 1 ? "step" : "steps"}`);
  if (props.tokenStats && props.tokenStats.sessionTotal > 0) {
    parts.push(`${formatCompact(props.tokenStats.sessionTotal)} tok`);
  }
  if (props.cacheHitRate != null) parts.push(`Cache hit ${Math.round(props.cacheHitRate * 100)}%`);

  return (
    <div className="session-status" role="status">
      {parts.map((part, i) => (
        <span key={part} className="session-status__part">
          {i > 0 && <span className="session-status__sep" aria-hidden>·</span>}
          {part}
        </span>
      ))}
    </div>
  );
}
