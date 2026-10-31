import { Engine, type EngineDeps } from "../src/core/engine.js";
import { State } from "../src/core/state.js";
import type { Trigger } from "../src/core/types.js";
import { settingsPolicy, type SourceScope } from "../src/policy.js";
import { parseSettings, type Settings } from "../src/settings.js";

export const REPO = "acme/app";
export const AGENT = "agent-bot";

/** Observation scope of the GitHub source under test: every row is listened to; a row is observed when its flag is set. */
export const scopeOf = (settings: Settings): SourceScope => ({
  scope: ({ meta }) => {
    const kind = meta.kind;
    const row = kind === "issue" ? "issues" : kind === "pull" ? "pulls" : kind === "conversation" || kind === "inline" || kind === "review" ? "comments" : undefined;
    const observed = row === "issues" ? settings.github.observeIssues : row === "pulls" ? settings.github.observePulls : row === "comments" ? settings.github.observeComments : false;
    return { listened: true, observed, ...(row ? { row } : {}) };
  },
});

export function makeSettings(patch: Record<string, unknown> = {}): Settings {
  const base = {
    enabled: true,
    github: { repository: REPO },
    policy: { sources: { github: { allowed: [{ id: "alice" }, { id: "bob" }], bots: [{ id: "review-bot[bot]" }] } } },
    eval: { mode: "observe" },
  };
  const merged = { ...base, ...patch, github: { ...base.github, ...(patch.github as object | undefined) } };
  return parseSettings(merged);
}

export interface Rig {
  state: State;
  engine: Engine;
  settings: Settings;
  clock: { now: Date };
  setSettings(next: Settings): void;
  advance(ms: number): void;
}

export function makeRig(initial: Settings = makeSettings(), clock: { now: Date } = { now: new Date("2026-01-01T00:00:00.000Z") }): Rig {
  const rig = { settings: initial } as { settings: Settings };
  const state = new State();
  const deps: EngineDeps = {
    policy: () => settingsPolicy(rig.settings, scopeOf(rig.settings)),
    now: () => clock.now,
    execution: ({ ticketId, name, title, taken }) => {
      let chosen = name ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) ?? ticketId;
      let n = 2;
      const base = chosen;
      while (taken.has(chosen)) chosen = `${base}-${n++}`;
      return { name: chosen, directory: `/work/${chosen}`, assignment: `Do ${title}` };
    },
  };
  const engine = new Engine(state, deps);
  return {
    state,
    engine,
    clock,
    get settings() {
      return rig.settings;
    },
    setSettings(next: Settings) {
      rig.settings = next;
    },
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
}

let counter = 0;
export function trigger(patch: Partial<Trigger> & { number?: number } = {}): Trigger {
  const number = patch.number ?? 1;
  const id = patch.id ?? `trg-${++counter}`;
  const { number: _number, ...rest } = patch;
  return {
    id,
    source: "github",
    threads: [{ source: "github", id: String(number) }],
    actor: { source: "github", id: "alice" },
    human: true,
    at: "2026-01-01T00:00:00.000Z",
    text: "please fix the typo in the readme",
    channel: { source: "github", thread: `github:${number}`, address: { number: String(number) } },
    meta: { number, isPr: false, kind: "conversation" },
    ...rest,
  };
}

/** A person at `alice` addressing the agent: an explicit request. */
export const request = (patch: Partial<Trigger> & { number?: number } = {}): Trigger =>
  trigger({ addressed: "mention", text: `@${AGENT} fix the typo`, ...patch });
