import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isConductorRunActive, parseConductorRunEvent, reduceConductorRun, type ConductorRun } from "../conductorRun.js";

export type ConductorRunStartResult = { ok: true } | { ok: false; error: string };

export interface ConductorRunApi {
  /** The latest pipeline run seen this session (started here, by the agent, or by the scheduler). */
  run: ConductorRun | null;
  start: (workflowId: string, cwd: string) => Promise<ConductorRunStartResult>;
  abort: () => Promise<void>;
  nudge: () => Promise<void>;
  /** Hide a finished run from the strip. */
  dismiss: () => void;
}

const UNAVAILABLE: ConductorRunStartResult = { ok: false, error: "Pipelines are not available here." };

/** Outside a provider (isolated renders, the web build) there is simply never a run. */
const NO_RUNS: ConductorRunApi = {
  run: null,
  start: async () => UNAVAILABLE,
  abort: async () => {},
  nudge: async () => {},
  dismiss: () => {},
};

const ConductorRunContext = createContext<ConductorRunApi>(NO_RUNS);

/**
 * Owns the one subscription to host workflow events. The run strip and the Pipeline
 * tab both read from it, so neither misses events while the other (or the
 * right panel) is closed.
 */
export function ConductorRunProvider({
  onRunStarted,
  children,
}: {
  /** Fired for every new run, whoever started it. */
  onRunStarted?: (runId: string) => void;
  children: ReactNode;
}) {
  const [run, setRun] = useState<ConductorRun | null>(null);
  const runRef = useRef(run);
  runRef.current = run;
  const onRunStartedRef = useRef(onRunStarted);
  onRunStartedRef.current = onRunStarted;

  useEffect(() => {
    const api = window.deyin?.conductorWorkflows;
    if (!api?.onEvent) return;
    return api.onEvent((raw) => {
      const event = parseConductorRunEvent(raw);
      if (!event) return;
      setRun((current) => reduceConductorRun(current, event));
      if (event.type === "workflow:started") onRunStartedRef.current?.(event.runId);
    });
  }, []);

  const start = useCallback(async (workflowId: string, cwd: string): Promise<ConductorRunStartResult> => {
    const api = window.deyin?.conductorWorkflows;
    if (!api) return UNAVAILABLE;
    try {
      const res = await api.run(workflowId, cwd);
      return res.ok ? { ok: true } : { ok: false, error: "The pipeline did not start." };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, []);

  const abort = useCallback(async () => {
    const current = runRef.current;
    const api = window.deyin?.conductorWorkflows;
    if (!current || !api || !isConductorRunActive(current.status)) return;
    const found = await api.abort(current.runId);
    if (found) return; // the host's `workflow:aborted` event settles the status
    // The host no longer knows this run (e.g. it restarted): stop showing it as live.
    setRun((latest) =>
      latest && latest.runId === current.runId ? { ...latest, status: "aborted", finishedAt: Date.now() } : latest,
    );
  }, []);

  const nudge = useCallback(async () => {
    const current = runRef.current;
    const api = window.deyin?.externalAgents;
    if (!current || !api || !isConductorRunActive(current.status)) return;
    await api.nudge(current.runId, "Ping: status check requested by user.");
  }, []);

  const dismiss = useCallback(() => {
    setRun((current) => (current && !isConductorRunActive(current.status) ? null : current));
  }, []);

  const value = useMemo<ConductorRunApi>(() => ({ run, start, abort, nudge, dismiss }), [run, start, abort, nudge, dismiss]);
  return <ConductorRunContext.Provider value={value}>{children}</ConductorRunContext.Provider>;
}

export function useConductorRun(): ConductorRunApi {
  return useContext(ConductorRunContext);
}

/** A wall clock that ticks once a second while `enabled`, for live elapsed timers. */
export function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/**
 * Tail of a run's external-agent output. Polls only while `enabled` (the monitor
 * is on screen) and the run is `active`; a finished run is fetched once so its
 * output stays readable.
 */
export function useConductorRunLogs(runId: string | null, active: boolean, enabled: boolean): string[] {
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    setLogs([]);
  }, [runId]);

  useEffect(() => {
    const api = window.deyin?.externalAgents;
    if (!runId || !enabled || !api) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const lines = await api.logs(runId, 200);
        if (!cancelled) setLogs(lines);
      } catch {
        // Polled every second while live; a failed pull simply retries on the next tick.
      }
    };
    void pull();
    if (!active) {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(() => void pull(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId, active, enabled]);

  return logs;
}
