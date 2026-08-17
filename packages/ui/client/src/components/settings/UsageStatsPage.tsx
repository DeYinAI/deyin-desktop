import { useMemo, useState } from "react";
import { Icon } from "../Icon.js";
import { PageHeader } from "./controls.js";
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
  const [rangeDays, setRangeDays] = useState(30);

  const windowDays = useMemo(() => {
    if (!stats) return [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - rangeDays);
    const key = dayKey(cutoff);
    return stats.days.filter((d) => d.date >= key);
  }, [stats, rangeDays]);

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
        <span className="badge badge--muted">App usage</span>
      </PageHeader>

      {!account && (
        <div className="usage-card">
          <div className="usage-card__title">Openference account</div>
          <div className="hint">
            {signedIn
              ? "Account usage is unavailable right now (offline or the service is unreachable)."
              : "Sign in with Openference to see server-side plan usage here."}
          </div>
          {signedIn && (
            <button className="chip chip--small" style={{ marginTop: 8 }} disabled={refreshing} onClick={onRefreshAccount}>
              {refreshing ? "Refreshing…" : "Retry"}
            </button>
          )}
        </div>
      )}
      {account && (
        <div className="usage-card">
          <div className="usage-card__title">
            Openference account
            {account.planName && <span className="badge badge--muted">{account.planName}</span>}
            <span className="usage-card__spacer" />
            <button className="icon-btn icon-btn--small" title="Refresh from Openference" disabled={refreshing} onClick={onRefreshAccount}>
              <Icon name="refresh" size={12} />
            </button>
          </div>
          <div className="stat-grid">
            <StatCard label="Requests today" value={fmt(account.todayRequests)} />
            <StatCard
              label="Requests this week"
              value={fmt(account.weekRequests)}
              note={account.requestsPerWeek ? `of ${fmt(account.requestsPerWeek)}` : undefined}
            />
            <StatCard
              label="Tokens this week"
              value={fmt(account.weekTokens)}
              note={account.tokensPerWeek ? `of ${fmt(account.tokensPerWeek)}` : undefined}
            />
            <StatCard label="All-time requests" value={fmt(account.totalRequests)} />
            <StatCard label="All-time tokens" value={fmt(account.totalTokens)} />
            {account.creditsUsd !== null && <StatCard label="Credits" value={`$${account.creditsUsd.toFixed(2)}`} />}
          </div>
          {account.weeklyResetAt && (
            <div className="hint usage-card__foot">
              Weekly quota resets {new Date(account.weeklyResetAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      <div className="usage-range">
        <span className="hint">Time range</span>
        <div className="usage-range__spacer" />
        <button className={`chip chip--small ${rangeDays === 7 ? "chip--active" : ""}`} onClick={() => setRangeDays(7)}>
          Last 7 days
        </button>
        <button className={`chip chip--small ${rangeDays === 30 ? "chip--active" : ""}`} onClick={() => setRangeDays(30)}>
          Last 30 days
        </button>
      </div>

      <div className="stat-grid">
        <StatCard label="Token usage" value={fmt(windowTokens)} />
        <StatCard label="Sessions" value={String(windowSessions)} />
        <StatCard label="Messages" value={String(windowMessages)} />
        <StatCard label="Active days" value={String(stats?.activeDays ?? 0)} />
        <StatCard label="Current streak" value={String(stats?.currentStreak ?? 0)} />
        <StatCard
          label="Favorite model"
          value={stats?.favoriteModel?.id ?? "—"}
          note={stats?.favoriteModel ? `${stats.favoriteModel.share}% share` : undefined}
        />
      </div>

      <div className="usage-card">
        <div className="usage-card__title">Token optimization</div>
        <p className="hint">
          Compression and prompt caching run in the core agent. Enable the Semantic Optimization plugin under Settings
          → Agent data for tool/response caches. Per-session savings appear on agent runs when optimization events
          are emitted.
        </p>
      </div>

      <div className="usage-card">
        <div className="usage-card__title">Activity heatmap</div>
        <Heatmap stats={stats} />
      </div>

      <div className="usage-card">
        <div className="usage-card__title">Tokens per day</div>
        <BarChart days={windowDays} models={models} />
        <div className="usage-legend">
          {models.slice(0, CHART_COLORS.length).map((m, i) => (
            <span className="usage-legend__item" key={m}>
              <span className="usage-legend__dot" style={{ background: CHART_COLORS[i] }} />
              {m}
            </span>
          ))}
          {models.length === 0 && <span className="hint">No usage recorded yet. Chat to start collecting stats.</span>}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value">{value}</div>
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

  const weeks = 18;
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
