import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { DeyinSettings } from "../shared/types.js";

export const DEFAULT_SETTINGS: DeyinSettings = {
  theme: "dark",
  language: "en",
  fontSize: 14,
  autoUpdate: true,
  telemetry: false,
  browserControlEnabled: true,
  defaultModel: null,
  approvalMode: "full-access",
  thinking: true,
  codeThemeLight: "GitHub Light",
  codeThemeDark: "GitHub Dark",
  showLineNumbers: true,
  wrapLongLines: false,
  codeFontSize: 12,
};

/** Tiny atomic-enough JSON persistence used by the settings/caps/usage stores. */
export class JsonFile<T> {
  constructor(
    private readonly file: string,
    private readonly fallback: T,
  ) {}

  read(): T {
    try {
      return { ...this.fallback, ...(JSON.parse(readFileSync(this.file, "utf8")) as T) };
    } catch {
      return structuredClone(this.fallback);
    }
  }

  write(value: T): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(value, null, 2), "utf8");
  }
}

/** File-backed user settings at userData/settings.json. */
export class SettingsStore {
  private readonly json: JsonFile<DeyinSettings>;
  private cache: DeyinSettings;

  constructor(dir: string = app.getPath("userData")) {
    this.json = new JsonFile(join(dir, "settings.json"), DEFAULT_SETTINGS);
    this.cache = this.json.read();
  }

  get(): DeyinSettings {
    return this.cache;
  }

  set(patch: Partial<DeyinSettings>): DeyinSettings {
    this.cache = { ...this.cache, ...patch };
    this.json.write(this.cache);
    return this.cache;
  }
}
