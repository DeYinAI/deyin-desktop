/**
 * Aggregated Advanced agent integration metrics (cache, coordinator, fleet, UI).
 * Privacy-respecting: no prompts, paths, or code — only coarse counters and rates.
 */

export interface Advanced agentMetricsSnapshot {
  /** ISO timestamp of last update. */
  updatedAt: string;
  /** Week bucket YYYY-Www for rollup reports. */
  weekBucket: string;

  cache: {
    sessionsTracked: number;
    totalHits: number;
    totalMisses: number;
    hitRate: number;
    invalidations: number;
    compactions: number;
    estimatedTokenSavings: number;
  };

  coordinator: {
    runs: number;
    plannerInvocations: number;
    executorOnly: number;
    fallbacks: number;
    routeCounts: Record<string, number>;
  };

  fleet: {
    runs: number;
    tasksStarted: number;
    tasksCompleted: number;
    conflicts: number;
    backgroundJobsCompleted: number;
  };

  evidence: {
    gateRejections: number;
    signOffs: number;
    rejectionCodes: Record<string, number>;
  };

  ui: {
    settingsOpens: number;
    avgLoadMs: number;
    loadSamples: number;
  };
}

export interface Advanced agentWeeklyReport {
  generatedAt: string;
  weekBucket: string;
  snapshot: Advanced agentMetricsSnapshot;
  notes: string[];
}

const EMPTY: Advanced agentMetricsSnapshot = {
  updatedAt: new Date(0).toISOString(),
  weekBucket: weekBucketFor(new Date()),
  cache: {
    sessionsTracked: 0,
    totalHits: 0,
    totalMisses: 0,
    hitRate: 0,
    invalidations: 0,
    compactions: 0,
    estimatedTokenSavings: 0,
  },
  coordinator: {
    runs: 0,
    plannerInvocations: 0,
    executorOnly: 0,
    fallbacks: 0,
    routeCounts: {},
  },
  fleet: {
    runs: 0,
    tasksStarted: 0,
    tasksCompleted: 0,
    conflicts: 0,
    backgroundJobsCompleted: 0,
  },
  evidence: {
    gateRejections: 0,
    signOffs: 0,
    rejectionCodes: {},
  },
  ui: {
    settingsOpens: 0,
    avgLoadMs: 0,
    loadSamples: 0,
  },
};

function weekBucketFor(d: Date): string {
  const start = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d.getTime() - start.getTime()) / 86_400_000);
  const week = Math.ceil((days + start.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function deepClone(s: Advanced agentMetricsSnapshot): Advanced agentMetricsSnapshot {
  return JSON.parse(JSON.stringify(s)) as Advanced agentMetricsSnapshot;
}

/** Persisted metrics store with weekly rollover. */
export class Advanced agentMetricsStore {
  private snapshot: Advanced agentMetricsSnapshot;

  constructor(private readonly persist: (data: Advanced agentMetricsSnapshot) => void, initial?: Advanced agentMetricsSnapshot) {
    this.snapshot = initial ? deepClone(initial) : deepClone(EMPTY);
    this.maybeRollWeek();
  }

  get(): Advanced agentMetricsSnapshot {
    return deepClone(this.snapshot);
  }

  private touch(): void {
    this.maybeRollWeek();
    this.snapshot.updatedAt = new Date().toISOString();
    this.persist(this.snapshot);
  }

  private maybeRollWeek(): void {
    const current = weekBucketFor(new Date());
    if (this.snapshot.weekBucket !== current) {
      this.snapshot = { ...deepClone(EMPTY), weekBucket: current };
    }
  }

  recordCacheTurn(hit: number, miss: number, invalidated: boolean, compaction: boolean, tokenSavingsUsd = 0): void {
    this.snapshot.cache.totalHits += Math.max(0, hit);
    this.snapshot.cache.totalMisses += Math.max(0, miss);
    const total = this.snapshot.cache.totalHits + this.snapshot.cache.totalMisses;
    this.snapshot.cache.hitRate = total === 0 ? 0 : this.snapshot.cache.totalHits / total;
    if (invalidated) this.snapshot.cache.invalidations += 1;
    if (compaction) this.snapshot.cache.compactions += 1;
    this.snapshot.cache.estimatedTokenSavings += Math.max(0, tokenSavingsUsd);
    this.touch();
  }

  recordCacheSession(): void {
    this.snapshot.cache.sessionsTracked += 1;
    this.touch();
  }

  recordCoordinatorRun(route: string, plannerUsed: boolean, fallback: boolean): void {
    this.snapshot.coordinator.runs += 1;
    if (plannerUsed) this.snapshot.coordinator.plannerInvocations += 1;
    if (route === "executor_only") this.snapshot.coordinator.executorOnly += 1;
    if (fallback) this.snapshot.coordinator.fallbacks += 1;
    this.snapshot.coordinator.routeCounts[route] = (this.snapshot.coordinator.routeCounts[route] ?? 0) + 1;
    this.touch();
  }

  recordFleetRun(tasks: number, completed: number, conflict: boolean): void {
    this.snapshot.fleet.runs += 1;
    this.snapshot.fleet.tasksStarted += tasks;
    this.snapshot.fleet.tasksCompleted += completed;
    if (conflict) this.snapshot.fleet.conflicts += 1;
    this.touch();
  }

  recordBackgroundJobCompleted(): void {
    this.snapshot.fleet.backgroundJobsCompleted += 1;
    this.touch();
  }

  recordEvidenceGate(code: string): void {
    this.snapshot.evidence.gateRejections += 1;
    this.snapshot.evidence.rejectionCodes[code] = (this.snapshot.evidence.rejectionCodes[code] ?? 0) + 1;
    this.touch();
  }

  recordEvidenceSignOff(): void {
    this.snapshot.evidence.signOffs += 1;
    this.touch();
  }

  recordSettingsOpen(): void {
    this.snapshot.ui.settingsOpens += 1;
    this.touch();
  }

  recordUiLoadMs(ms: number): void {
    const n = this.snapshot.ui.loadSamples;
    this.snapshot.ui.avgLoadMs = (this.snapshot.ui.avgLoadMs * n + ms) / (n + 1);
    this.snapshot.ui.loadSamples += 1;
    this.touch();
  }

  generateWeeklyReport(): Advanced agentWeeklyReport {
    const snap = this.get();
    const notes: string[] = [];
    if (snap.cache.hitRate >= 0.8) notes.push("Cache hit rate meets ≥80% target.");
    else if (snap.cache.totalHits + snap.cache.totalMisses > 0) {
      notes.push(`Cache hit rate ${(snap.cache.hitRate * 100).toFixed(1)}% — review prefix stability.`);
    }
    if (snap.coordinator.fallbacks > 0 && snap.coordinator.runs > 0) {
      const rate = snap.coordinator.fallbacks / snap.coordinator.runs;
      if (rate > 0.1) notes.push(`Coordinator fallback rate ${(rate * 100).toFixed(1)}% — check planner model availability.`);
    }
    if (snap.fleet.conflicts > 0) notes.push(`${snap.fleet.conflicts} fleet write-path conflict(s) — tighten write_paths claims.`);
    if (snap.evidence.gateRejections > snap.evidence.signOffs && snap.evidence.gateRejections > 5) {
      notes.push("Evidence gate rejections exceed sign-offs — users may need delivery workflow guidance.");
    }
    return {
      generatedAt: new Date().toISOString(),
      weekBucket: snap.weekBucket,
      snapshot: snap,
      notes,
    };
  }
}

export function emptyAdvanced agentMetrics(): Advanced agentMetricsSnapshot {
  return deepClone(EMPTY);
}
