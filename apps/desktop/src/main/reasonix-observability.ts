/**
 * In-memory observability ring buffers for Reasonix developer tools.
 * Thread-scoped entries power the settings diagnostics panels.
 */

import type {
  ReasonixDiagnostics,
  ReasonixCacheInvalidationEntry,
  ReasonixCoordinatorEntry,
  ReasonixEvidenceEntry,
  ReasonixFleetEntry,
} from "@deyin/host-core";

type PrefixShapeView = NonNullable<ReasonixDiagnostics["cache"]["prefixShape"]>;
type CacheInvalidationEntry = ReasonixCacheInvalidationEntry;
type CoordinatorDecisionEntry = ReasonixCoordinatorEntry;
type FleetTimelineEntry = ReasonixFleetEntry;
type EvidenceRejectionEntry = ReasonixEvidenceEntry;

export type { ReasonixDiagnostics };

const MAX_ENTRIES = 200;

export class ReasonixObservability {
  private cacheByThread = new Map<
    string,
    { prefixShape: PrefixShapeView | null; sessionHit: number; sessionMiss: number; hitRate: number }
  >();
  private invalidations: CacheInvalidationEntry[] = [];
  private coordinatorLog: CoordinatorDecisionEntry[] = [];
  private fleetTimeline: FleetTimelineEntry[] = [];
  private evidenceRejections: EvidenceRejectionEntry[] = [];

  recordPrefixShape(
    threadId: string,
    shape: PrefixShapeView,
    reasons: string[],
    hit: number,
    miss: number,
  ): void {
    const prev = this.cacheByThread.get(threadId);
    const sessionHit = (prev?.sessionHit ?? 0) + hit;
    const sessionMiss = (prev?.sessionMiss ?? 0) + miss;
    const total = sessionHit + sessionMiss;
    this.cacheByThread.set(threadId, {
      prefixShape: shape,
      sessionHit,
      sessionMiss,
      hitRate: total === 0 ? 0 : sessionHit / total,
    });

    if (reasons.length > 0) {
      this.push(this.invalidations, {
        at: Date.now(),
        threadId,
        reasons,
        prefixHash: shape.prefixHash,
        logRewriteVersion: shape.logRewriteVersion,
        hitRate: total === 0 ? undefined : sessionHit / total,
      });
    }
  }

  recordCoordinatorDecision(threadId: string, route: string, reason: string): void {
    this.push(this.coordinatorLog, { at: Date.now(), threadId, route, reason });
  }

  recordFleetEvent(
    threadId: string,
    kind: FleetTimelineEntry["kind"],
    detail: string,
    taskCount?: number,
  ): void {
    this.push(this.fleetTimeline, { at: Date.now(), threadId, kind, detail, taskCount });
  }

  recordEvidenceRejection(threadId: string, code: string, message: string): void {
    this.push(this.evidenceRejections, { at: Date.now(), threadId, code, message });
  }

  clearThreadCache(threadId: string): void {
    this.cacheByThread.delete(threadId);
    this.invalidations = this.invalidations.filter((e) => e.threadId !== threadId);
  }

  getDiagnostics(threadId?: string): ReasonixDiagnostics {
    const cacheState = threadId ? this.cacheByThread.get(threadId) : undefined;
    const filter = <T extends { threadId: string }>(list: T[]) =>
      threadId ? list.filter((e) => e.threadId === threadId) : list;

    return {
      cache: {
        prefixShape: cacheState?.prefixShape ?? null,
        invalidationHistory: filter(this.invalidations).slice(-50),
        sessionHit: cacheState?.sessionHit ?? 0,
        sessionMiss: cacheState?.sessionMiss ?? 0,
        hitRate: cacheState?.hitRate ?? 0,
      },
      coordinator: filter(this.coordinatorLog).slice(-50),
      fleet: filter(this.fleetTimeline).slice(-50),
      evidence: filter(this.evidenceRejections).slice(-50),
    };
  }

  private push<T>(list: T[], entry: T): void {
    list.push(entry);
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
  }
}

