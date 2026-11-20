/**
 * What the Servers page shows and is told, for the Bot engines on the person's servers. Plain data with nothing
 * secret in it: the engine's key never leaves the main process.
 */

/** What keeps the engine running on the server, and so what a restart or a log-out does to it. */
export type EngineSupervisor = "systemd" | "nohup";

export type EngineBusy = "installing" | "removing";

export interface EngineHostView {
  /** The saved SSH host. */
  hostId: string;
  label: string;
  /** `user@host:port`, as the person added it. */
  address: string;
  /** The server's host key is pinned. Nothing is run on a server before that. */
  pinned: boolean;
  /** Present when an engine has been set up on this server. */
  engine?: {
    port: number;
    version?: string;
    supervisor: EngineSupervisor;
    /** Whether the engine comes back by itself after the server restarts. */
    survivesReboot: boolean;
    installedAt: number;
    /** A connection to it is open right now. */
    connected: boolean;
  };
  /** How many Bots are set to run on this server. */
  bots: number;
  /** Set while setup or removal is running here. */
  busy?: EngineBusy;
}

/** How a live engine is, as far as the person needs to know. */
export interface EngineStatusView {
  version: string;
  startedAt: number;
  /** The `deyin` command the engine runs Bots with is on the server. */
  agentFound: boolean;
  agentVersion?: string;
  /** It is signed in there. A Bot cannot run until it is. */
  signedIn: boolean;
  runningNow: number;
  bots: Array<{ botId: string; routines: number; running: number }>;
}

export type EngineSetupStepState = "running" | "done" | "skipped";

/** What happens during setup, in order, for the progress list. */
export type EngineSetupEvent =
  | { type: "step"; hostId: string; step: string; state: EngineSetupStepState; message: string }
  /** The server needs the person to approve a sign-in in a browser; `url` is what the server printed, so it is shown, not trusted. */
  | { type: "sign-in"; hostId: string; url: string; code: string }
  | { type: "finished"; hostId: string; ok: true; version: string; warnings: string[] }
  | { type: "finished"; hostId: string; ok: false; message: string };

/** The Bot a person asks about when a server cannot run it. */
export interface BotRuntimeHealthView {
  ok: boolean;
  version?: string;
  /** Why not, in words for the person. */
  reason?: string;
}

/**
 * Where a Bot's routine runs by itself when the Bot lives on a server: there, so it keeps running while this app is
 * closed; or not yet, and why. A routine the app starts itself has none of this.
 */
export type RoutineServerView =
  | { state: "server"; hostId: string; hostLabel: string }
  | { state: "blocked" | "waiting"; hostId: string; hostLabel: string; reason: string };
