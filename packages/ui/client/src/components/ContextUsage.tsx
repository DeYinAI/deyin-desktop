import { useEffect, useRef, useState } from "react";
import { PortalledPanel } from "./PortalledPanel.js";
import { Icon } from "./Icon.js";
import type { AccountUsage, ContextCategoryId, ContextUsageSnapshot } from "@deyin/contract";

const CATEGORY_COLORS: Record<ContextCategoryId, string> = {
  system: "#8b949e",
  tools: "#a371f7",
  rules: "#3fb950",
  skills: "#d29922",
  mcp: "#db61a2",
  subagents: "#79c0ff",
  conversation: "#f85149",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Quota consumption is fractional once per-model multipliers apply; the
 *  meters read as call counts, so round before display. */
function formatRequests(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Countdown to a quota reset. Weekly resets are days away and rolling-window
 *  resets are minutes away, so the unit pair shifts with the distance. */
function formatReset(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "resets soon";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `resets in ${days}d ${hours % 24}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${minutes}m`;
}

export interface ContextUsageProps {
  snapshot: ContextUsageSnapshot | null;
  /** Live model context window — preferred over any baked snapshot.contextLength. */
  contextLength?: number;
  /** Close the popover when this changes (active thread id). */
  threadKey?: string | null;
  /** Rough token estimate for pending @ attachments (chars / 4). */
  attachmentEstimateTokens?: number;
}

/** Circular meter + Cursor-style Context Usage popover above the composer. */
export function ContextUsage({ snapshot, contextLength, threadKey, attachmentEstimateTokens = 0 }: ContextUsageProps) {
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState<AccountUsage | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const measured = snapshot != null;

  // Prefer the live model window so model switches update % without waiting for a new run.
  const used = (snapshot?.usedTokens ?? 0) + attachmentEstimateTokens;
  const limit = (contextLength && contextLength > 0 ? contextLength : 0) || snapshot?.contextLength || 0;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const ringTone = percent >= 90 ? "critical" : percent >= 70 ? "warn" : "ok";
  const attachmentHeavy = attachmentEstimateTokens > 0 && limit > 0 && attachmentEstimateTokens / limit > 0.5;
  const categories = (snapshot?.categories ?? []).filter((c) => c.tokens > 0);

  useEffect(() => {
    setOpen(false);
  }, [threadKey]);

  // Pull the cached Openference account snapshot whenever the popover opens;
  // the host layer serves it from disk within its TTL so this stays cheap.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void window.deyin.usage
      .account(false)
      .then((a) => {
        if (alive) setAccount(a);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const size = 18;
  const stroke = 2.25;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * Math.min(1, percent / 100);

  const wire = snapshot?.wire;
  const wireSaved =
    wire && wire.originalTokens > wire.compressedTokens
      ? wire.originalTokens - wire.compressedTokens
      : 0;

  const meterTitle = measured
    ? `Context ${percent}% full${limit > 0 ? ` (~${formatTokens(used)} / ${formatTokens(limit)})` : ""}`
    : "Context usage not measured yet";
  const meterAria = measured
    ? `Context usage ${percent}% full`
    : "Context usage not measured yet";

  return (
    <div className="context-usage">
      <button
        ref={anchorRef}
        type="button"
        className={`context-usage__meter context-usage__meter--${ringTone} ${open ? "context-usage__meter--open" : ""}`}
        title={meterTitle}
        aria-label={meterAria}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle
            className="context-usage__track"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
          />
          <circle
            className={`context-usage__fill context-usage__fill--${ringTone}`}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeDasharray={`${dash} ${circ}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
      </button>

      <PortalledPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        align="end"
        className="context-usage__popover context-usage__popover--portalled"
        role="dialog"
        ariaLabel="Context Usage"
      >
        <div className="context-usage__header">
            <span className="context-usage__title">Context Usage</span>
            <button
              type="button"
              className="context-usage__close"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>

          <div className="context-usage__summary">
            <span className="context-usage__percent">
              {measured ? `${percent}% Full` : "Not measured"}
            </span>
            <span className="context-usage__tokens">
              {!measured
                ? "Send a message to estimate"
                : limit > 0
                  ? `~${formatTokens(used)} / ${formatTokens(limit)} Tokens`
                  : `~${formatTokens(used)} Tokens`}
            </span>
          </div>

          <div className="context-usage__bar" aria-hidden>
            {!measured || categories.length === 0 ? (
              <div className="context-usage__bar-empty" />
            ) : (
              categories.map((c) => (
                <div
                  key={c.id}
                  className="context-usage__seg"
                  style={{
                    flexGrow: Math.max(c.tokens, 1),
                    background: CATEGORY_COLORS[c.id],
                  }}
                  title={`${c.label}: ${formatTokens(c.tokens)}`}
                />
              ))
            )}
            {measured && limit > used && (
              <div
                className="context-usage__seg context-usage__seg--free"
                style={{ flexGrow: Math.max(limit - used, 1) }}
              />
            )}
          </div>

          <ul className="context-usage__list">
            {categories.map((c) => (
              <li key={c.id} className="context-usage__row">
                <span
                  className="context-usage__dot"
                  style={{ background: CATEGORY_COLORS[c.id] }}
                  aria-hidden
                />
                <span className="context-usage__label">{c.label}</span>
                <span className="context-usage__count">{formatTokens(c.tokens)}</span>
              </li>
            ))}
            {categories.length === 0 && (
              <li className="context-usage__row context-usage__row--empty">
                <span className="context-usage__label">
                  {measured ? "No context categories" : "No context measured yet"}
                </span>
              </li>
            )}
          </ul>

          {account && (
            <div className="context-usage__plan">
              <div className="context-usage__plan-head">
                <span className="context-usage__plan-title">Openference</span>
                {account.planName && <span className="context-usage__plan-badge">{account.planName}</span>}
                <span className="context-usage__plan-spacer" />
                <span className="context-usage__plan-today">
                  {account.todayRequests.toLocaleString()} today
                </span>
              </div>
              {account.requestsPerWindow !== null && (
                <PlanMeter
                  label={
                    account.windowHours
                      ? `Requests this ${account.windowHours}h`
                      : "Requests this window"
                  }
                  used={account.windowQuotaUsed}
                  limit={account.requestsPerWindow}
                  formatValue={formatRequests}
                  resetAt={account.windowResetAt}
                />
              )}
              <PlanMeter
                label="Requests this week"
                used={account.weekQuotaUsed}
                limit={account.requestsPerWeek}
                formatValue={formatRequests}
              />
              <PlanMeter
                label="Tokens this week"
                used={account.weekTokens}
                limit={account.tokensPerWeek}
                formatValue={formatTokens}
              />
              {(account.weeklyResetAt || account.creditsUsd !== null) && (
                <div className="context-usage__plan-foot">
                  {account.weeklyResetAt && <span>{formatReset(account.weeklyResetAt)}</span>}
                  {account.creditsUsd !== null && <span>${account.creditsUsd.toFixed(2)} credits</span>}
                </div>
              )}
            </div>
          )}

          {(attachmentHeavy || snapshot?.cached || wireSaved > 0 || snapshot?.cache) && (
            <div className="context-usage__footer">
              {attachmentHeavy && <span>Large attachments may exceed the context budget</span>}
              {snapshot?.cached && <span>Served from response cache</span>}
              {wireSaved > 0 && <span>Wire compression saved ~{formatTokens(wireSaved)}</span>}
              {snapshot?.cache && snapshot.cache.sessionHit + snapshot.cache.sessionMiss > 0 && (
                <span>
                  Prefix cache: {Math.round(snapshot.cache.hitRate * 100)}% hit (
                  {formatTokens(snapshot.cache.sessionHit)} cached /{" "}
                  {formatTokens(snapshot.cache.sessionMiss)} new)
                  {snapshot.cache.prefixChanged && snapshot.cache.changeReasons?.length
                    ? ` · churn: ${snapshot.cache.changeReasons.join(", ")}`
                    : ""}
                </span>
              )}
            </div>
          )}
      </PortalledPanel>
    </div>
  );
}

/** One Openference quota row: label, used/limit, a thin progress bar and an
 *  optional reset countdown (rolling windows reset far more often than weekly
 *  quotas, so their row carries its own). */
function PlanMeter({
  label,
  used,
  limit,
  formatValue,
  resetAt,
}: {
  label: string;
  used: number;
  limit: number | null;
  formatValue: (n: number) => string;
  resetAt?: string | null;
}) {
  const percent = limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const tone = percent === null ? "none" : percent >= 90 ? "critical" : percent >= 70 ? "warn" : "ok";
  return (
    <div className="context-usage__meter-row">
      <div className="context-usage__meter-top">
        <span className="context-usage__meter-label">{label}</span>
        <span className="context-usage__meter-count">
          {percent !== null ? `${formatValue(used)} / ${formatValue(limit!)} · ${percent}%` : formatValue(used)}
        </span>
      </div>
      <div className="context-usage__meter-bar" aria-hidden>
        {percent !== null && (
          <div className={`context-usage__meter-fill context-usage__meter-fill--${tone}`} style={{ width: `${percent}%` }} />
        )}
      </div>
      {resetAt && <div className="context-usage__meter-foot">{formatReset(resetAt)}</div>}
    </div>
  );
}
