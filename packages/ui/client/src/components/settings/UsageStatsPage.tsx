import { useMemo, useState } from "react";
import { Icon, type IconName } from "../Icon.js";
import { EmptyState, PageHeader, SectionHeader, Segmented, UnderlineTabs } from "./controls.js";
import type { AccountUsage, UsageStats } from "@deyin/contract";

const CHART_COLORS = ["#4f7cff", "#3fb950", "#a371f7", "#d29922", "#ff7b72", "#39c5cf"];

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface Props {
  stats: UsageStats | null;
  /** Server-side Openference account usage; null when signed out or unavailable. */
  account: AccountUsage | null;
  /** True while the user is signed in (distinguishes "signed out" from "unreachable"). */
  signedIn: boolean;
  /** Force-refresh the cached account snapshot. */
  onRefreshAccount: () => void;
  refreshing: boolean;
}

export function UsageStatsPage({ stats, account, signedIn, onRefreshAccount, refreshing }: Props) {
  const [rangeDays, setRangeDays] = useState<"7" | "30">("30");
  const [tab, setTab] = useState<"app" | "plan">("app");
  const days = Number(rangeDays);

  const windowDays = useMemo(() => {
    if (!stats) return [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const key = dayKey(cutoff);
    return stats.days.filter((d) => d.date >= key);
  }, [stats, days]);

  const windowTokens = windowDays.reduce(
    (sum, d) => sum + Object.values(d.byModel).reduce((a, b) => a + b, 0),
    0,
  );
  const windowMessages = windowDays.reduce((sum, d) => sum + d.messages, 0);
  const windowSessions = windowDays.reduce((sum, d) => sum + d.sessions, 0);

  const models = useMemo(() => {
    const totals = new Map<string, number>();
    for (const d of windowDays) {
      for (const [m, t] of Object.entries(d.byModel)) totals.set(m, (totals.get(m) ?? 0) + t);
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [windowDays]);

  return (
    <div className="settings-page">
      <PageHeader title="Usage stats">
        <button
          className="icon-btn"
          title="Refresh account usage"
          disabled={refreshing || !signedIn}
          onClick={onRefreshAccount}
        >
          <Icon name="refresh" size={14} />
        </button>
      </PageHeader>

      <UnderlineTabs
        tabs={[
          { id: "app", label: "App usage" },
          { id: "plan", label: "Plan" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "app" && (
        <>
          <SectionHeader
            title="Time range"
            actions={
              <Segmented
                size="sm"
                options={[
                  { id: "7", label: "Last 7 days" },
                  { id: "30", label: "Last 30 days" },
                ]}
                value={rangeDays}
                onChange={setRangeDays}
              />
            }
          />

          <div className="stat-grid">
            <StatCard icon="clock" label="Token usage" value={fmt(windowTokens)} />
            <StatCard icon="layout" label="Sessions" value={String(windowSessions)} />
            <StatCard icon="message" label="Messages" value={String(windowMessages)} />
            <StatCard icon="chart" label="Active days" value={String(stats?.activeDays ?? 0)} />
            <StatCard icon="bolt" label="Current streak" value={String(stats?.currentStreak ?? 0)} />
            <StatCard
              icon="star"
              label="Favorite model"
              value={stats?.favoriteModel?.id ?? "—"}
              note={stats?.favoriteModel ? `${stats.favoriteModel.share}% share` : undefined}
            />
          </div>

          <div className="usage-card">
            <div className="usage-card__title">
              Activity heatmap
              <span className="usage-card__spacer" />
              <span className="hint">Last 12 months</span>
            </div>
            <Heatmap stats={stats} />
          </div>

          <div className="usage-card">
            <div className="usage-card__title">
              Tokens per day
              <span className="usage-card__spacer" />
              <span className="hint">Last {days} days</span>
            </div>
            <BarChart days={windowDays} models={models} />
            <div className="usage-legend">
              {models.slice(0, CHART_COLORS.length).map((m, i) => (
                <span className="usage-legend__item" key={m}>
                  <span className="usage-legend__dot" style={{ background: CHART_COLORS[i] }} />
                  {m}
                </span>
              ))}
              {models.length === 0 && (
                <span className="hint">No usage recorded yet. Chat to start collecting stats.</span>
              )}
            </div>
          </div>
        </>
      )}

      {tab === "plan" && (
        <>
          {!account ? (
            <EmptyState
              icon="user"
              title={signedIn ? "Account usage is unavailable right now." : "Sign in to see plan usage"}
              hint={
                signedIn
                  ? "You are offline or the Openference service is unreachable. Use refresh to retry."
                  : "Sign in with Openference to see server-side plan usage here."
              }
            />
          ) : (
            <>
              <SectionHeader
                title="Openference account"
                note={account.planName ?? undefined}
                actions={
                  account.weeklyResetAt ? (
                    <span className="section-head__note">
                      Weekly quota resets {new Date(account.weeklyResetAt).toLocaleString()}
                    </span>
                  ) : undefined
                }
              />
              <div className="stat-grid">
                <StatCard icon="arrowUp" label="Requests today" value={fmt(account.todayRequests)} />
                {account.requestsPerWindow !== null && (
                  <StatCard
                    icon="clock"
                    label={
                      account.windowHours
                        ? `Requests this ${account.windowHours}h`
                        : "Requests this window"
                    }
                    value={fmt(Math.round(account.windowQuotaUsed))}
                    note={`of ${fmt(account.requestsPerWindow)}`}
                  />
                )}
                {/* Quota-used, not the raw call count: per-model multipliers mean
                    that is what the limit beside it is enforced against. */}
                <StatCard
                  icon="chart"
                  label="Requests this week"
                  value={fmt(Math.round(account.weekQuotaUsed))}
                  note={account.requestsPerWeek ? `of ${fmt(account.requestsPerWeek)}` : undefined}
                />
                <StatCard
                  icon="clock"
                  label="Tokens this week"
                  value={fmt(account.weekTokens)}
                  note={account.tokensPerWeek ? `of ${fmt(account.tokensPerWeek)}` : undefined}
                />
                <StatCard icon="list" label="All-time requests" value={fmt(account.totalRequests)} />
                <StatCard icon="cpu" label="All-time tokens" value={fmt(account.totalTokens)} />
                {account.creditsUsd !== null && (
                  <StatCard icon="star" label="Credits" value={`$${account.creditsUsd.toFixed(2)}`} />
                )}
              </div>
            </>
          )}

          <div className="usage-card">
            <div className="usage-card__title">Token optimization</div>
            <p className="hint">
              Compression and prompt caching run in the core agent. Enable the Semantic Optimization plugin under
              Settings → Agent data for tool and response caches.
            </p>
          </div>
        </>
      )}
    </div>
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

/** GitHub-style 18-week activity grid. */
function Heatmap({ stats }: { stats: UsageStats | null }) {
  const byDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of stats?.days ?? []) {
      map.set(d.date, Object.values(d.byModel).reduce((a, b) => a + b, 0));
    }
    return map;
  }, [stats]);

  const weeks = 52;
  const cells: { key: string; level: number }[][] = [];
  const start = new Date();
  start.setDate(start.getDate() - (weeks * 7 - 1));
  // Align to the previous Sunday for tidy columns.
  start.setDate(start.getDate() - start.getDay());

  const max = Math.max(1, ...byDate.values());
  for (let w = 0; w < weeks; w++) {
    const col: { key: string; level: number }[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(start.getDate() + w * 7 + d);
      const key = dayKey(day);
      const tokens = byDate.get(key) ?? 0;
      const level = tokens === 0 ? 0 : Math.min(4, 1 + Math.floor((tokens / max) * 3.999));
      col.push({ key, level });
    }
    cells.push(col);
  }

  return (
    <div className="heatmap">
      <div className="heatmap__grid">
        {cells.map((col, i) => (
          <div className="heatmap__col" key={i}>
            {col.map((cell) => (
              <span key={cell.key} className={`heatmap__cell heatmap__cell--${cell.level}`} title={cell.key} />
            ))}
          </div>
        ))}
      </div>
      <div className="heatmap__legend">
        <span className="hint">Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={`heatmap__cell heatmap__cell--${l}`} />
        ))}
        <span className="hint">More</span>
      </div>
    </div>
  );
}

/** Stacked bar chart of tokens per day, colored by model. */
function BarChart({ days, models }: { days: UsageStats["days"]; models: string[] }) {
  const max = Math.max(1, ...days.map((d) => Object.values(d.byModel).reduce((a, b) => a + b, 0)));
  const colorOf = (model: string) => CHART_COLORS[models.indexOf(model) % CHART_COLORS.length];

  return (
    <div className="barchart">
      {days.length === 0 && <div className="hint barchart__empty">No activity in this range.</div>}
      {days.map((day) => {
        const total = Object.values(day.byModel).reduce((a, b) => a + b, 0);
        return (
          <div className="barchart__slot" key={day.date} title={`${day.date}: ${fmt(total)} tokens`}>
            <div className="barchart__bar" style={{ height: `${(total / max) * 100}%` }}>
              {Object.entries(day.byModel).map(([model, tokens]) => (
                <div
                  key={model}
                  className="barchart__seg"
                  style={{ flexGrow: tokens, background: colorOf(model) }}
                />
              ))}
            </div>
            <span className="barchart__label">{day.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}
