import { Icon, type IconName } from "../Icon.js";
import { EmptyState, SectionHeader } from "./controls.js";
import type { AccountUsage } from "@deyin/contract";

export function fmtUsage(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface Props {
  account: AccountUsage | null;
  signedIn: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** When true, omit the outer section header (embedded in Account page). */
  embedded?: boolean;
}

/** Openference plan usage from `/api/user/me` — shared by Usage stats and Account. */
export function AccountUsagePanel({ account, signedIn, onRefresh, refreshing, embedded }: Props) {
  if (!account) {
    return (
      <EmptyState
        icon="user"
        title={signedIn ? "Account usage is unavailable right now." : "Sign in to see plan usage"}
        hint={
          signedIn
            ? "You are offline or the Openference service is unreachable. Use refresh to retry."
            : "Sign in with Openference to see server-side plan usage here."
        }
      />
    );
  }

  return (
    <>
      <SectionHeader
        title={embedded ? "Usage" : "Openference account"}
        note={account.planName ?? undefined}
        actions={
          <>
            {account.weeklyResetAt ? (
              <span className="section-head__note">
                Weekly quota resets {new Date(account.weeklyResetAt).toLocaleString()}
              </span>
            ) : null}
            {onRefresh ? (
              <button
                className="icon-btn"
                title="Refresh account usage"
                disabled={refreshing || !signedIn}
                onClick={onRefresh}
              >
                <Icon name="refresh" size={14} />
              </button>
            ) : null}
          </>
        }
      />
      <div className="stat-grid">
        <StatCard icon="arrowUp" label="Requests today" value={fmtUsage(account.todayRequests)} />
        {account.requestsPerWindow !== null && (
          <StatCard
            icon="clock"
            label={
              account.windowHours ? `Requests this ${account.windowHours}h` : "Requests this window"
            }
            value={fmtUsage(Math.round(account.windowQuotaUsed))}
            note={`of ${fmtUsage(account.requestsPerWindow)}`}
          />
        )}
        <StatCard
          icon="chart"
          label="Requests this week"
          value={fmtUsage(Math.round(account.weekQuotaUsed))}
          note={account.requestsPerWeek ? `of ${fmtUsage(account.requestsPerWeek)}` : undefined}
        />
        <StatCard
          icon="clock"
          label="Tokens this week"
          value={fmtUsage(account.weekTokens)}
          note={account.tokensPerWeek ? `of ${fmtUsage(account.tokensPerWeek)}` : undefined}
        />
        <StatCard icon="list" label="All-time requests" value={fmtUsage(account.totalRequests)} />
        <StatCard icon="cpu" label="All-time tokens" value={fmtUsage(account.totalTokens)} />
        {account.creditsUsd !== null && (
          <StatCard icon="star" label="Credits" value={`$${account.creditsUsd.toFixed(2)}`} />
        )}
      </div>
    </>
  );
}

function StatCard({ icon, label, value, note }: { icon: IconName; label: string; value: string; note?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-card__label">
        <Icon name={icon} size={12} />
        {label}
      </div>
      <div className="stat-card__value" title={value}>
        {value}
      </div>
      {note && <div className="stat-card__note">{note}</div>}
    </div>
  );
}
