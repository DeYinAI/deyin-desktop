import { CH } from "@deyin/contract";
import {
  BotFrameworkKeys,
  BotFrameworkTokens,
  type ActivityLog,
  type DeyinBot,
  type HttpFetch,
  type Outbox,
  type SurfaceStore,
  type XCursors,
} from "@deyin/host-core";
import { createSurfaceHandlers } from "./surface-handlers.js";
import { SurfaceHub } from "./surface-hub.js";
import { XPoller } from "./surface-x-poller.js";
import type { RunEnd, RunWatch } from "./run-watch.js";

export interface SurfaceWiringDeps {
  store: SurfaceStore;
  outbox: Outbox;
  cursors: XCursors;
  activity: ActivityLog;
  runWatch: RunWatch;
  bots: { get(id: string): DeyinBot | undefined };
  routines: { get(routineId: string): { id: string; botId?: string; enabled: boolean } | undefined };
  /** Hand a message to a routine: the run it starts. */
  invoke(routineId: string, text: string): { id: string };
  fetch: HttpFetch;
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
  broadcast(channel: string, payload: unknown): void;
  log?: (message: string) => void;
  xIntervalMs?: number;
}

export interface SurfaceWiring {
  hub: SurfaceHub;
  poller: XPoller;
  /** A Bot was deleted: close its ways in and forget everything kept for it. */
  removeBot(botId: string): void;
  /** Stop listening and asking. */
  dispose(): Promise<void>;
}

/** A call out that gives up: a service that never answers must not hold a reply, or a post, forever. */
export function withTimeout(fetchImpl: HttpFetch, ms = 15_000): HttpFetch {
  return (url, init) => fetchImpl(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) });
}

/**
 * Connects the hub, the X poller and the Connections panel's calls to the app. The hub listens only while something
 * calls it (a webhook, email, Slack or Teams surface that is on and complete), and the panel is told whenever anything
 * it shows changes.
 */
export function registerSurfaces(deps: SurfaceWiringDeps): SurfaceWiring {
  const { store, outbox, activity } = deps;
  const fetchImpl = withTimeout(deps.fetch);
  const settled = (runId: string): Promise<RunEnd> => deps.runWatch.settled(runId);

  const hub = new SurfaceHub({
    store,
    routines: deps.routines,
    invoke: deps.invoke,
    settled,
    fetch: fetchImpl,
    keys: new BotFrameworkKeys(fetchImpl),
    tokens: new BotFrameworkTokens(fetchImpl),
    activity,
    ...(deps.log ? { log: deps.log } : {}),
  });
  const poller = new XPoller({
    store,
    routines: deps.routines,
    invoke: deps.invoke,
    settled,
    outbox,
    cursors: deps.cursors,
    fetch: fetchImpl,
    activity,
    ...(deps.xIntervalMs !== undefined ? { intervalMs: deps.xIntervalMs } : {}),
  });

  // Changes come in bursts (a message is a log entry, a state change and a hub start); the panel hears once per burst.
  let pending = false;
  const changed = (): void => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      deps.broadcast(CH.botSurfacesChanged, null);
    }, 25).unref();
  };

  let hubWork: Promise<void> = Promise.resolve();
  const syncHub = (): Promise<void> => {
    hubWork = hubWork
      .then(async () => {
        const wanted = store.active().some((view) => view.surface !== "x");
        const status = hub.status();
        const port = store.hubSettings().port;
        const gaveUp = status.error !== undefined && status.port === port;
        if (wanted && !status.listening && !gaveUp) await hub.start(port);
        else if (!wanted && status.listening) await hub.stop();
      })
      .catch((error: unknown) => deps.log?.(`surface hub: ${error instanceof Error ? error.message : String(error)}`))
      .finally(changed);
    return hubWork;
  };

  const handlers = createSurfaceHandlers({
    bots: deps.bots,
    store,
    outbox,
    activity,
    routines: deps.routines,
    hub: {
      status: () => hub.status(),
      start: async (port) => {
        const status = await hub.start(port);
        changed();
        return status;
      },
    },
    fetch: fetchImpl,
  });

  const { handle } = deps;
  handle(CH.botSurfacesState, (botId) => handlers.state(botId));
  handle(CH.botSurfacesSave, (botId, kind, input) => handlers.save(botId, kind, input));
  handle(CH.botSurfacesRemake, (botId, kind, name) => handlers.remake(botId, kind, name));
  handle(CH.botSurfacesSetEnabled, (botId, kind, enabled) => handlers.setEnabled(botId, kind, enabled));
  handle(CH.botSurfacesRemove, (botId, kind) => handlers.remove(botId, kind));
  handle(CH.botSurfacesSetHub, (settings) => handlers.setHub(settings));
  handle(CH.botSurfacesOutboxEdit, (id, text) => handlers.outboxEdit(id, text));
  handle(CH.botSurfacesOutboxApprove, (id) => handlers.outboxApprove(id));
  handle(CH.botSurfacesOutboxDeny, (id) => handlers.outboxDeny(id));

  store.onChange(() => {
    void syncHub();
    changed();
  });
  outbox.onChange(changed);
  activity.onChange(changed);

  poller.start();
  void syncHub();

  return {
    hub,
    poller,
    removeBot: (botId) => {
      store.removeBot(botId);
      outbox.removeBot(botId);
      activity.forgetBot(botId);
      deps.cursors.forget(botId);
      hub.forgetBot(botId);
      poller.forgetBot(botId);
    },
    dispose: async () => {
      poller.stop();
      await hubWork;
      await hub.stop();
    },
  };
}
