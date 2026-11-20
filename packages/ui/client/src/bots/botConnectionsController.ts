import type { AutomationInfo } from "@deyin/contract";
import type { OutboxPost, SurfaceKind } from "@deyin/host-core/shared";
import { attempt, attemptPlain } from "./botCalls.js";
import type { RoutineDefaults, RoutinesApi } from "./botRoutines.js";
import {
  approveDraft,
  formFromView,
  hubFormFrom,
  hubInput,
  hubProblem,
  inputFromForm,
  makeMessageRoutine,
  type ConnectionsLoad,
  type HubForm,
  type SurfaceForm,
  type SurfacesApi,
} from "./botSurfaces.js";

/** What one card remembers while it is being used. */
export interface CardState {
  busy: boolean;
  error: string | null;
  /** Saved and nothing changed since. */
  saved: boolean;
  /** A routine for messages is being made for this card. */
  making: boolean;
}

export interface ConnectionsState {
  load: ConnectionsLoad;
  /** Every routine, so the Bot's own can be offered; null until they have arrived. */
  automations: AutomationInfo[] | null;
  /** The form of each card that is open. */
  forms: Partial<Record<SurfaceKind, SurfaceForm>>;
  cards: Partial<Record<SurfaceKind, CardState>>;
  /** Keys this app made, held here only until the person says they have copied them. */
  generated: Partial<Record<SurfaceKind, Record<string, string>>>;
  /** The address settings as edited, or null while they are as saved. */
  hub: { form: HubForm | null; busy: boolean; error: string | null; saved: boolean };
  /** Words typed over a draft that has not been decided. */
  edits: Record<string, string>;
  outbox: { busyId: string | null; errors: Record<string, string> };
  /** A refusal that belongs to the whole panel, not to one card. */
  notice: string | null;
}

export interface ConnectionsController {
  getState(): ConnectionsState;
  /** Starts listening on the first subscriber and stops with the last, so an unused controller costs nothing. */
  subscribe(listener: () => void): () => void;
  open(kind: SurfaceKind): void;
  close(kind: SurfaceKind): void;
  change(kind: SurfaceKind, patch: Partial<SurfaceForm>): void;
  save(kind: SurfaceKind): Promise<void>;
  toggle(kind: SurfaceKind, enabled: boolean): Promise<void>;
  remove(kind: SurfaceKind): Promise<void>;
  remake(kind: SurfaceKind, name: string): Promise<void>;
  makeRoutine(kind: SurfaceKind, name: string, defaults: RoutineDefaults): Promise<void>;
  dismissGenerated(kind: SurfaceKind, name: string): void;
  changeHub(patch: Partial<HubForm>): void;
  saveHub(): Promise<void>;
  retryHub(): Promise<void>;
  editPost(id: string, text: string): void;
  approve(post: OutboxPost): Promise<void>;
  deny(id: string): Promise<void>;
}

interface ControllerOptions {
  botId: string;
  api: SurfacesApi;
  routines: Pick<RoutinesApi, "list" | "create" | "onChange">;
}

const FRESH_CARD: CardState = { busy: false, error: null, saved: false, making: false };

export function initialConnectionsState(): ConnectionsState {
  return {
    load: { status: "loading" },
    automations: null,
    forms: {},
    cards: {},
    generated: {},
    hub: { form: null, busy: false, error: null, saved: false },
    edits: {},
    outbox: { busyId: null, errors: {} },
    notice: null,
  };
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/**
 * Everything the Connections panel does, apart from drawing it: loading what the host knows, keeping what a person has
 * typed, and making the calls. It never throws; a refusal becomes words in the state. A load that is overtaken by a newer
 * one is dropped, and a call that finishes after the last listener left changes nothing.
 */
export function createConnectionsController(options: ControllerOptions): ConnectionsController {
  const { botId, api, routines } = options;
  let state = initialConnectionsState();
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  let loads = 0;

  const set = (next: ConnectionsState): void => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const patch = (changes: Partial<ConnectionsState>): void => set({ ...state, ...changes });

  const card = (kind: SurfaceKind): CardState => state.cards[kind] ?? FRESH_CARD;
  const setCard = (kind: SurfaceKind, changes: Partial<CardState>): void => patch({ cards: { ...state.cards, [kind]: { ...card(kind), ...changes } } });
  const viewOf = (kind: SurfaceKind) => (state.load.status === "ready" ? state.load.state.surfaces.find((surface) => surface.surface === kind) : undefined);
  const closeForm = (kind: SurfaceKind): void => {
    const { [kind]: _gone, ...forms } = state.forms;
    patch({ forms });
  };

  const reload = async (): Promise<void> => {
    loads += 1;
    const mine = loads;
    const outcome = await attempt(() => api.state(botId));
    if (!stop || mine !== loads) return;
    if (outcome.ok) patch({ load: { status: "ready", state: outcome.value } });
    // A refresh that fails leaves what is on screen; only a first load has nothing to fall back on.
    else if (state.load.status === "ready") patch({ notice: outcome.error });
    else patch({ load: { status: "error", error: outcome.error } });
  };

  const loadRoutines = async (): Promise<void> => {
    const outcome = await attemptPlain(() => routines.list());
    if (stop && outcome.ok) patch({ automations: outcome.value });
  };

  const start = (): void => {
    if (stop) return;
    const offSurfaces = api.onChange(() => void reload());
    // Where routines cannot be watched the list is read when asked for, which is when the panel opens.
    const offRoutines = routines.onChange?.((list) => {
      if (stop) patch({ automations: list });
    });
    stop = () => {
      offSurfaces();
      offRoutines?.();
    };
    void reload();
    void loadRoutines();
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
          // What was loaded may be old by the time anyone looks again.
          loads += 1;
        }
      };
    },

    open(kind) {
      if (state.forms[kind]) return;
      patch({ forms: { ...state.forms, [kind]: formFromView(kind, viewOf(kind)) }, notice: null });
      setCard(kind, { error: null, saved: false });
    },
    close(kind) {
      closeForm(kind);
      setCard(kind, { error: null });
    },
    change(kind, changes) {
      const form = state.forms[kind];
      if (!form) return;
      patch({ forms: { ...state.forms, [kind]: { ...form, ...changes } } });
      setCard(kind, { error: null, saved: false });
    },

    async save(kind) {
      const form = state.forms[kind];
      if (!form || card(kind).busy) return;
      setCard(kind, { busy: true, error: null, saved: false });
      const outcome = await attempt(() => api.save(botId, kind, inputFromForm(form, viewOf(kind)?.enabled ?? false)));
      if (!stop) return;
      if (!outcome.ok) {
        setCard(kind, { busy: false, error: outcome.error });
        return;
      }
      const made = outcome.value.generated;
      closeForm(kind);
      patch({ generated: Object.keys(made).length > 0 ? { ...state.generated, [kind]: { ...state.generated[kind], ...made } } : state.generated });
      setCard(kind, { busy: false, error: null, saved: true });
      await reload();
    },

    async toggle(kind, enabled) {
      if (card(kind).busy) return;
      setCard(kind, { busy: true });
      patch({ notice: null });
      const outcome = await attempt(() => api.setEnabled(botId, kind, enabled));
      if (!stop) return;
      setCard(kind, { busy: false });
      if (!outcome.ok) patch({ notice: outcome.error });
      await reload();
    },

    async remove(kind) {
      if (card(kind).busy) return;
      setCard(kind, { busy: true });
      const outcome = await attempt(() => api.remove(botId, kind));
      if (!stop) return;
      if (!outcome.ok) {
        setCard(kind, { busy: false });
        patch({ notice: outcome.error });
        return;
      }
      const { [kind]: _form, ...forms } = state.forms;
      const { [kind]: _keys, ...generated } = state.generated;
      const { [kind]: _card, ...cards } = state.cards;
      patch({ forms, generated, cards, notice: null });
      await reload();
    },

    async remake(kind, name) {
      if (card(kind).busy) return;
      setCard(kind, { busy: true, error: null });
      const outcome = await attempt(() => api.remake(botId, kind, name));
      if (!stop) return;
      if (!outcome.ok) {
        setCard(kind, { busy: false, error: outcome.error });
        return;
      }
      patch({ generated: { ...state.generated, [kind]: { ...state.generated[kind], [name]: outcome.value.value } } });
      setCard(kind, { busy: false });
      await reload();
    },

    async makeRoutine(kind, name, defaults) {
      if (card(kind).making) return;
      setCard(kind, { making: true, error: null });
      const outcome = await makeMessageRoutine(routines, botId, name, defaults);
      if (!stop) return;
      if (!outcome.ok) {
        setCard(kind, { making: false, error: outcome.error });
        return;
      }
      await loadRoutines();
      const form = state.forms[kind];
      if (form) patch({ forms: { ...state.forms, [kind]: { ...form, routineId: outcome.value } } });
      setCard(kind, { making: false, saved: false });
    },

    dismissGenerated(kind, name) {
      const keys = state.generated[kind];
      if (!keys || !(name in keys)) return;
      const rest = without(keys, name);
      const { [kind]: _gone, ...others } = state.generated;
      patch({ generated: Object.keys(rest).length > 0 ? { ...others, [kind]: rest } : others });
    },

    changeHub(changes) {
      const base = state.hub.form ?? (state.load.status === "ready" ? hubFormFrom(state.load.state.hub.settings) : null);
      if (!base) return;
      patch({ hub: { ...state.hub, form: { ...base, ...changes }, error: null, saved: false } });
    },
    async saveHub() {
      const form = state.hub.form;
      if (!form || state.hub.busy) return;
      if (hubProblem(form) !== null) return;
      patch({ hub: { ...state.hub, busy: true, error: null, saved: false } });
      const outcome = await attempt(() => api.setHub(hubInput(form)));
      if (!stop) return;
      if (!outcome.ok) {
        patch({ hub: { ...state.hub, busy: false, error: outcome.error } });
        return;
      }
      patch({ hub: { form: null, busy: false, error: null, saved: true } });
      await reload();
    },
    async retryHub() {
      if (state.hub.busy || state.load.status !== "ready") return;
      patch({ hub: { ...state.hub, busy: true, error: null } });
      const outcome = await attempt(() => api.setHub(state.load.status === "ready" ? state.load.state.hub.settings : {}));
      if (!stop) return;
      patch({ hub: { ...state.hub, busy: false, error: outcome.ok ? null : outcome.error } });
      await reload();
    },

    editPost(id, text) {
      patch({ edits: { ...state.edits, [id]: text }, outbox: { ...state.outbox, errors: without(state.outbox.errors, id) } });
    },
    async approve(post) {
      if (state.outbox.busyId !== null) return;
      // What is posted is what is on screen, so a draft with no change is posted as it is.
      const text = state.edits[post.id] ?? post.text;
      patch({ outbox: { busyId: post.id, errors: without(state.outbox.errors, post.id) } });
      const outcome = await approveDraft(api, post, text);
      if (!stop) return;
      if (outcome.ok) patch({ edits: without(state.edits, post.id), outbox: { busyId: null, errors: state.outbox.errors } });
      else patch({ outbox: { busyId: null, errors: { ...state.outbox.errors, [post.id]: outcome.error } } });
      await reload();
    },
    async deny(id) {
      if (state.outbox.busyId !== null) return;
      patch({ outbox: { busyId: id, errors: without(state.outbox.errors, id) } });
      const outcome = await attempt(() => api.outboxDeny(id));
      if (!stop) return;
      if (outcome.ok) patch({ edits: without(state.edits, id), outbox: { busyId: null, errors: state.outbox.errors } });
      else patch({ outbox: { busyId: null, errors: { ...state.outbox.errors, [id]: outcome.error } } });
      await reload();
    },
  };
}
