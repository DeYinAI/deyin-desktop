import { EMPTY_BOT_LAYOUT } from "@deyin/host-core/shared";
import type { BotResult, BotsSnapshot, DeyinApi, DeyinBot } from "@deyin/contract";
import type { BotRosterLayout } from "@deyin/host-core/shared";

export type BotsApi = DeyinApi["bots"];

/** What the UI renders. `bots` and `layout` keep their identity until the host reports a change. */
export interface BotsClientState {
  /** False until the first roster has arrived, so the UI can tell "loading" from "no Bots yet". */
  ready: boolean;
  bots: DeyinBot[];
  layout: BotRosterLayout;
  /** Set when the roster could not be loaded. */
  loadError: string | null;
}

export interface BotsClient {
  getState(): BotsClientState;
  /** Starts listening on the first subscriber and stops with the last, so an unused client costs nothing. */
  subscribe(listener: () => void): () => void;
  /** Every host call, returning a refusal instead of throwing when Bots are unavailable or the call fails. */
  actions: BotsApi;
}

const UNAVAILABLE = "Bots need the Deyin Desktop app.";

function refusal<T>(error: string): BotResult<T> {
  return { ok: false, code: "invalid", error };
}

const INITIAL: BotsClientState = { ready: false, bots: [], layout: EMPTY_BOT_LAYOUT, loadError: null };
const UNAVAILABLE_STATE: BotsClientState = { ready: true, bots: [], layout: EMPTY_BOT_LAYOUT, loadError: null };

/** Keep a thrown IPC failure from escaping as an unhandled rejection: the UI shows the text instead. */
function guarded<A extends unknown[], T>(fn: (...args: A) => Promise<BotResult<T>>): (...args: A) => Promise<BotResult<T>> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error));
    }
  };
}

export function createBotsClient(api: BotsApi | undefined): BotsClient {
  let state: BotsClientState = api ? INITIAL : UNAVAILABLE_STATE;
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  /** Bumped by every push, so a slower `list()` can tell it has been overtaken. */
  let generation = 0;

  const set = (next: BotsClientState): void => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const apply = (snapshot: BotsSnapshot): void => {
    set({ ready: true, bots: snapshot.bots, layout: snapshot.layout, loadError: null });
  };

  const start = (): void => {
    if (!api || stop) return;
    const seen = generation;
    const unsubscribe = api.onChange((snapshot) => {
      generation += 1;
      apply(snapshot);
    });
    let active = true;
    stop = () => {
      active = false;
      unsubscribe();
    };
    api
      .list()
      .then((snapshot) => {
        // A push that landed first is newer than this answer.
        if (active && generation === seen) apply(snapshot);
      })
      .catch((error: unknown) => {
        if (!active || generation !== seen) return;
        set({ ...state, ready: true, loadError: error instanceof Error ? error.message : String(error) });
      });
  };

  const actions: BotsApi = api
    ? {
        list: api.list.bind(api),
        create: guarded(api.create.bind(api)),
        update: guarded(api.update.bind(api)),
        archive: guarded(api.archive.bind(api)),
        restore: guarded(api.restore.bind(api)),
        delete: guarded(api.delete.bind(api)),
        setPrimary: guarded(api.setPrimary.bind(api)),
        setPinned: guarded(api.setPinned.bind(api)),
        setHidden: guarded(api.setHidden.bind(api)),
        addSection: guarded(api.addSection.bind(api)),
        renameSection: guarded(api.renameSection.bind(api)),
        removeSection: guarded(api.removeSection.bind(api)),
        moveToSection: guarded(api.moveToSection.bind(api)),
        memoryList: guarded(api.memoryList.bind(api)),
        memoryForget: guarded(api.memoryForget.bind(api)),
        memoryShare: guarded(api.memoryShare.bind(api)),
        onChange: api.onChange.bind(api),
      }
    : {
        list: async () => ({ bots: [], layout: EMPTY_BOT_LAYOUT }),
        create: async () => refusal(UNAVAILABLE),
        update: async () => refusal(UNAVAILABLE),
        archive: async () => refusal(UNAVAILABLE),
        restore: async () => refusal(UNAVAILABLE),
        delete: async () => refusal(UNAVAILABLE),
        setPrimary: async () => refusal(UNAVAILABLE),
        setPinned: async () => refusal(UNAVAILABLE),
        setHidden: async () => refusal(UNAVAILABLE),
        addSection: async () => refusal(UNAVAILABLE),
        renameSection: async () => refusal(UNAVAILABLE),
        removeSection: async () => refusal(UNAVAILABLE),
        moveToSection: async () => refusal(UNAVAILABLE),
        memoryList: async () => refusal(UNAVAILABLE),
        memoryForget: async () => refusal(UNAVAILABLE),
        memoryShare: async () => refusal(UNAVAILABLE),
        onChange: () => () => {},
      };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stop) {
          stop();
          stop = null;
        }
      };
    },
    actions,
  };
}
