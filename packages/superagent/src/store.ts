/**
 * Durable JSON files for one Superagent deployment: `state.json` (the domain State) and `settings.json` (settings plus a
 * revision for optimistic concurrency). Writes are atomic (temp file, then rename) and keep the previous generation as `.bak`,
 * which loading falls back to, so a crash mid-write or a torn file never loses the whole history.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UserError } from "./core/errors.js";
import { State, type StateData } from "./core/state.js";
import { defaultSettings, parseSettings, type Settings } from "./settings.js";

export interface StoreLogger {
  warn(message: string): void;
}

interface SettingsFile {
  revision: number;
  settings: unknown;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/**
 * Reads a JSON file and checks it with `parse`, falling back to its `.bak` generation when the file is unreadable or not what `parse`
 * accepts (a torn write can leave valid JSON that is not a state); `undefined` when neither exists.
 * @throws when both are unusable.
 */
function readGenerations<T>(path: string, parse: (raw: unknown) => T, logger?: StoreLogger): T | undefined {
  const failures: string[] = [];
  for (const candidate of [path, `${path}.bak`]) {
    if (!existsSync(candidate)) continue;
    try {
      const value = parse(readJson(candidate));
      if (candidate !== path) logger?.warn(`superagent: ${path} was unusable; recovered from ${candidate}`);
      return value;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`Superagent data is unreadable and was left untouched. ${failures.join("; ")}`);
  return undefined;
}

/** Writes `value` atomically, keeping the previous file as `.bak`. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  if (existsSync(path)) renameSync(path, `${path}.bak`);
  renameSync(temp, path);
}

export class JsonStore {
  private revision = 0;
  private settingsValue: Settings = defaultSettings();
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private written = 0;
  private state: State | undefined;
  private failed: Error | undefined;

  constructor(
    readonly dir: string,
    private readonly options: { debounceMs?: number; logger?: StoreLogger } = {},
  ) {}

  private get statePath(): string {
    return join(this.dir, "state.json");
  }
  private get settingsPath(): string {
    return join(this.dir, "settings.json");
  }

  /** Loads settings and state; creates neither file until something changes. */
  load(): { state: State; settings: Settings } {
    mkdirSync(this.dir, { recursive: true });
    const stored = readGenerations(
      this.settingsPath,
      (raw) => {
        const file = raw as Partial<SettingsFile> | null;
        if (!file || typeof file.revision !== "number" || !Number.isInteger(file.revision) || file.revision < 0) throw new Error("not a settings file");
        return { revision: file.revision, settings: parseSettings(file.settings) };
      },
      this.options.logger,
    );
    if (stored) {
      this.revision = stored.revision;
      this.settingsValue = stored.settings;
    }
    this.state = readGenerations(this.statePath, (raw) => State.from(raw as StateData), this.options.logger) ?? State.from(undefined);
    this.written = this.state.revision;
    return { state: this.state, settings: this.settingsValue };
  }

  get settings(): Settings {
    return this.settingsValue;
  }
  get settingsRevision(): number {
    return this.revision;
  }
  /** The last write error, cleared by the next successful write. */
  get lastError(): Error | undefined {
    return this.failed;
  }

  /** Replaces the settings. @throws UserError("conflict") when `baseRevision` is not the current revision. */
  saveSettings(raw: unknown, baseRevision: number): { settings: Settings; revision: number; previous: Settings } {
    if (baseRevision !== this.revision) throw new UserError("conflict");
    const next = parseSettings(raw);
    const previous = this.settingsValue;
    this.settingsValue = next;
    this.revision++;
    writeJsonAtomic(this.settingsPath, { revision: this.revision, settings: next } satisfies SettingsFile);
    return { settings: next, revision: this.revision, previous };
  }

  /** Starts persisting `state` whenever it changes, coalescing bursts into one write per debounce window. */
  autosave(): void {
    const state = this.state;
    if (!state || this.unsubscribe) return;
    this.unsubscribe = state.onChange(() => this.schedule());
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.options.debounceMs ?? 400);
    this.timer.unref?.();
  }

  /** Writes the state now if it changed since the last write. */
  flush(): void {
    const state = this.state;
    if (!state || state.revision === this.written) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      writeJsonAtomic(this.statePath, state.toJSON());
      this.written = state.revision;
      this.failed = undefined;
    } catch (error) {
      this.failed = error instanceof Error ? error : new Error(String(error));
      this.options.logger?.warn(`superagent: could not write state: ${this.failed.message}`);
      this.schedule();
    }
  }

  dispose(): void {
    this.flush();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Deletes all stored data (state and settings); the caller restarts from defaults. */
  reset(): void {
    this.dispose();
    for (const path of [this.statePath, this.settingsPath]) for (const file of [path, `${path}.bak`]) rmSync(file, { force: true });
    this.revision = 0;
    this.settingsValue = defaultSettings();
    this.state = State.from(undefined);
    this.written = this.state.revision;
  }
}
