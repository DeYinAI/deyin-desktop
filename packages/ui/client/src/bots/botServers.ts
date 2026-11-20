import type { BotResult, DeyinApi } from "@deyin/contract";
import type {
  BotPatch,
  DeyinBot,
  EngineHostView,
  EngineSetupEvent,
  EngineSetupStepState,
  EngineStatusView,
  MessageKey,
  RoutineServerView,
  RuntimeHealth,
} from "@deyin/host-core/shared";

/** The server and engine calls the pages need. Absent where there is no desktop host (the web build). */
export type ServersApi = NonNullable<DeyinApi["engines"]>;

/* Talking to the host ----------------------------------------------------- */

export type ServerOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run an engine call and give back its value or the reason it was refused, never a throw. */
export async function attemptServers<T>(run: () => Promise<BotResult<T>>): Promise<ServerOutcome<T>> {
  try {
    const result = await run();
    return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}

/** The list of servers, or why it could not be had. */
export async function attemptServerList(api: Pick<ServersApi, "list">): Promise<ServerOutcome<EngineHostView[]>> {
  try {
    return { ok: true, value: await api.list() };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}

/* Setup progress ---------------------------------------------------------- */

export interface SetupStepRow {
  step: string;
  state: EngineSetupStepState;
  message: string;
}

/** What the server asks of the person during setup. `url` is null when the link the server printed is not safe to open from here. */
export interface SignInView {
  url: string | null;
  code: string;
}

export type SetupFinish = { ok: true; version: string; warnings: string[] } | { ok: false; message: string };

/** How one server's setup is going, built from what the host reports. */
export interface SetupView {
  steps: SetupStepRow[];
  signIn: SignInView | null;
  finished: SetupFinish | null;
}

export type SetupViews = Readonly<Record<string, SetupView>>;

const EMPTY_SETUP: SetupView = { steps: [], signIn: null, finished: null };

/**
 * The sign-in link the server printed, if it is one to open: https, with no user name or password in it. The text
 * comes from another computer, so anything else is shown to nobody as a link.
 */
export function safeSignInUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return null;
  return parsed.href;
}

const CODE_LIMIT = 40;

/** The code to type in, without anything that is not part of one. Printed by the server, so it is cleaned before it is shown. */
export function cleanSignInCode(raw: string): string {
  return raw.replace(/[^\p{L}\p{N}\- ]/gu, "").trim().slice(0, CODE_LIMIT);
}

/** Fold one setup report into the views. A report for a server whose last setup is over starts a new one. */
export function reduceSetup(views: SetupViews, event: EngineSetupEvent): SetupViews {
  const existing = views[event.hostId];
  const base = existing && existing.finished === null ? existing : EMPTY_SETUP;
  switch (event.type) {
    case "step": {
      const row: SetupStepRow = { step: event.step, state: event.state, message: event.message };
      const at = base.steps.findIndex((candidate) => candidate.step === event.step);
      const steps = at === -1 ? [...base.steps, row] : base.steps.map((candidate, index) => (index === at ? row : candidate));
      // The sign-in is asked for during its own step, and is no longer needed once that step is over.
      const signIn = event.step === "sign-in" && event.state !== "running" ? null : base.signIn;
      return { ...views, [event.hostId]: { ...base, steps, signIn } };
    }
    case "sign-in":
      return { ...views, [event.hostId]: { ...base, signIn: { url: safeSignInUrl(event.url), code: cleanSignInCode(event.code) } } };
    case "finished": {
      const finished: SetupFinish = event.ok ? { ok: true, version: event.version, warnings: event.warnings } : { ok: false, message: event.message };
      return { ...views, [event.hostId]: { ...base, signIn: null, finished } };
    }
    default: {
      const unhandled: never = event;
      throw new Error(`Unhandled setup event: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Drop what is shown of a finished setup, e.g. when the person closes it. */
export function dismissSetup(views: SetupViews, hostId: string): SetupViews {
  const view = views[hostId];
  if (!view || view.finished === null) return views;
  const { [hostId]: _gone, ...rest } = views;
  return rest;
}

const STEP_LABEL: Record<string, MessageKey> = {
  probe: "servers.step.probe",
  cli: "servers.step.cli",
  "sign-in": "servers.step.signIn",
  key: "servers.step.key",
  start: "servers.step.start",
  verify: "servers.step.verify",
};

/** The name of a setup step, or null for one this version does not know (the row then shows the host's own message). */
export function stepLabelKey(step: string): MessageKey | null {
  return Object.hasOwn(STEP_LABEL, step) ? STEP_LABEL[step]! : null;
}

export const STEP_STATE_KEY: Record<EngineSetupStepState, MessageKey> = {
  running: "servers.stepState.running",
  done: "servers.stepState.done",
  skipped: "servers.stepState.skipped",
};

/* A server row ------------------------------------------------------------ */

export type ServerRowState = "needs-pin" | "not-installed" | "installing" | "removing" | "installed";

export interface ServerRow {
  state: ServerRowState;
  /** Setting up (or updating) the engine can be started. */
  canInstall: boolean;
  /** The engine can be asked how it is. */
  canCheck: boolean;
  canRemove: boolean;
  canForget: boolean;
  /** A setup or removal is running and can be stopped. */
  canCancel: boolean;
}

export function serverRow(host: EngineHostView): ServerRow {
  if (host.busy === "installing") return { state: "installing", canInstall: false, canCheck: false, canRemove: false, canForget: false, canCancel: true };
  if (host.busy === "removing") return { state: "removing", canInstall: false, canCheck: false, canRemove: false, canForget: false, canCancel: true };
  if (host.engine) return { state: "installed", canInstall: true, canCheck: true, canRemove: true, canForget: true, canCancel: false };
  if (!host.pinned) return { state: "needs-pin", canInstall: false, canCheck: false, canRemove: false, canForget: false, canCancel: false };
  return { state: "not-installed", canInstall: true, canCheck: false, canRemove: false, canForget: false, canCancel: false };
}

export const ROW_STATE_KEY: Record<ServerRowState, MessageKey> = {
  "needs-pin": "servers.state.needsPin",
  "not-installed": "servers.state.notInstalled",
  installing: "servers.state.installing",
  removing: "servers.state.removing",
  installed: "servers.state.installed",
};

/** Servers in the order the person added them is kept, except that ones with an engine come first. */
export function sortServers(hosts: readonly EngineHostView[]): EngineHostView[] {
  return [...hosts].sort((a, b) => Number(Boolean(b.engine)) - Number(Boolean(a.engine)));
}

export type EngineStatusState =
  | { status: "checking" }
  | { status: "error"; error: string }
  | { status: "ready"; view: EngineStatusView };

/** What the engine's status means for running Bots there: null when all is well, else the message to show. */
export function statusProblem(view: EngineStatusView): MessageKey | null {
  if (!view.agentFound) return "servers.status.noAgent";
  if (!view.signedIn) return "servers.status.signedOut";
  return null;
}

/* Where a Bot runs -------------------------------------------------------- */

export const LOCAL_PLACE = "local";
const SERVER_PREFIX = "server:";

export interface PlaceChoice {
  value: string;
  /** The server's name; null for this computer. */
  label: string | null;
  /** Why it cannot be chosen, as a message key, when it cannot. */
  unavailable: MessageKey | null;
}

/** The select's value for where a Bot runs now. */
export function placeValue(bot: Pick<DeyinBot, "harness" | "hostId">): string {
  return bot.harness === "server" && bot.hostId ? `${SERVER_PREFIX}${bot.hostId}` : LOCAL_PLACE;
}

/**
 * Where a Bot may be put: this computer, and each saved server that has an engine. A server without one is listed
 * but cannot be chosen, with the reason, so the person sees what to do. The Bot's current server stays on the list
 * even when it was removed, so the select can show where the Bot is set to run.
 */
export function placeChoices(hosts: readonly EngineHostView[], bot: Pick<DeyinBot, "harness" | "hostId">): PlaceChoice[] {
  const choices: PlaceChoice[] = [{ value: LOCAL_PLACE, label: null, unavailable: null }];
  for (const host of hosts) {
    choices.push({ value: `${SERVER_PREFIX}${host.hostId}`, label: host.label, unavailable: host.engine ? null : host.pinned ? "bot.place.noEngine" : "bot.place.notPinned" });
  }
  const current = placeValue(bot);
  if (current !== LOCAL_PLACE && !choices.some((choice) => choice.value === current)) {
    choices.push({ value: current, label: null, unavailable: "bot.place.missing" });
  }
  return choices;
}

/** The change to save for a place chosen in the select, or null when it names nothing that exists. */
export function placePatch(value: string): Pick<BotPatch, "harness" | "hostId"> | null {
  if (value === LOCAL_PLACE) return { harness: "local" };
  if (value.startsWith(SERVER_PREFIX) && value.length > SERVER_PREFIX.length) return { harness: "server", hostId: value.slice(SERVER_PREFIX.length) };
  return null;
}

/** The notes that go with a place, as message keys: what a Bot cannot do there, and what to expect. */
export function placeNotes(bot: Pick<DeyinBot, "harness" | "autoReview">): MessageKey[] {
  if (bot.harness !== "server") return [];
  const notes: MessageKey[] = ["bot.place.filesStay", "bot.place.limits"];
  if (bot.autoReview.approvalMode === "auto_review") notes.push("bot.place.reviewNote");
  return notes;
}

export type PlaceHealth = { status: "checking" } | { status: "ready"; version?: string } | { status: "notReady"; reason: string };

/** How a Bot's computer is, for the line under the select. */
export function placeHealth(outcome: ServerOutcome<RuntimeHealth>): PlaceHealth {
  if (!outcome.ok) return { status: "notReady", reason: outcome.error };
  if (outcome.value.ok) return { status: "ready", ...(outcome.value.version ? { version: outcome.value.version } : {}) };
  return { status: "notReady", reason: outcome.value.reason ?? "" };
}

/* Routines ---------------------------------------------------------------- */

/** The line under a routine that says where it runs by itself, as a key and what fills it. Null for one the app starts. */
export function routineServerLine(view: RoutineServerView | undefined): { key: MessageKey; vars: { server: string; reason: string }; tone: "ok" | "warn" } | null {
  if (!view) return null;
  switch (view.state) {
    case "server":
      return { key: "bot.routines.server.running", vars: { server: view.hostLabel, reason: "" }, tone: "ok" };
    case "blocked":
      return { key: "bot.routines.server.blocked", vars: { server: view.hostLabel, reason: view.reason }, tone: "warn" };
    case "waiting":
      return { key: "bot.routines.server.waiting", vars: { server: view.hostLabel, reason: view.reason }, tone: "warn" };
    default: {
      const unhandled: never = view;
      throw new Error(`Unhandled routine server state: ${JSON.stringify(unhandled)}`);
    }
  }
}
