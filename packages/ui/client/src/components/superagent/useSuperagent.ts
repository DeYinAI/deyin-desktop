import { useCallback, useEffect, useRef, useState } from "react";
import type { SuperagentReply } from "@deyin/contract";
import type { SuperagentView } from "@deyin/superagent/client";

export interface SuperagentController {
  /** `null` until the first view arrives. */
  view: SuperagentView | null;
  /** Why the first view could not be had, when it could not. */
  unavailable: string | null;
  busy: boolean;
  /** The message of the last failed action, until the next one starts. */
  error: string | null;
  clearError(): void;
  /** Runs a call; resolves to the view it returned, which replaces the one shown, or `undefined` when it failed. */
  act(call: () => Promise<SuperagentReply>): Promise<SuperagentView | undefined>;
  /** Like `act`, for a call whose reply is not a view; resolves to its value, or `undefined` when it failed. */
  ask<T>(call: () => Promise<SuperagentReply<T>>): Promise<T | undefined>;
}

/** The Superagent view, kept current by the main process's pushes, and the actions that change it. */
export function useSuperagent(): SuperagentController {
  const api = typeof window === "undefined" ? undefined : window.deyin.superagent;
  const [view, setView] = useState<SuperagentView | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How many calls are in flight: a second one must not clear the busy state of the first, and nothing is set once unmounted.
  const inFlight = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!api) {
      setUnavailable("Superagent runs in the desktop app.");
      return undefined;
    }
    let live = true;
    void api.view().then(
      (reply) => {
        if (!live) return;
        if (reply.ok) setView(reply.value);
        else setUnavailable(reply.error);
      },
      (cause: unknown) => live && setUnavailable(cause instanceof Error ? cause.message : String(cause)),
    );
    const stop = api.onChanged((next) => {
      if (live) setView(next);
    });
    return () => {
      live = false;
      stop();
    };
  }, [api]);

  const ask = useCallback(
    async <T,>(call: () => Promise<SuperagentReply<T>>): Promise<T | undefined> => {
      // Every control is disabled while a call is out, so a call that finds another one running is a double click.
      if (inFlight.current > 0) return undefined;
      inFlight.current += 1;
      setBusy(true);
      setError(null);
      try {
        const reply = await call();
        if (reply.ok) return reply.value;
        if (mounted.current) setError(reply.error);
        return undefined;
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
        return undefined;
      } finally {
        inFlight.current -= 1;
        if (mounted.current) setBusy(inFlight.current > 0);
      }
    },
    [],
  );

  const act = useCallback(
    async (call: () => Promise<SuperagentReply>): Promise<SuperagentView | undefined> => {
      const next = await ask(call);
      if (next && mounted.current) setView(next);
      return next;
    },
    [ask],
  );

  return { view, unavailable, busy, error, clearError: useCallback(() => setError(null), []), act, ask };
}
