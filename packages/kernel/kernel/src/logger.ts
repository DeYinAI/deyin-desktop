import type { PluginLogger } from "@deyin/extension-api";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Infinity,
};

/** Console-backed prefixed logger; the only logging implementation the kernel ships. */
export class ConsoleLogger implements PluginLogger {
  constructor(
    private readonly prefix: string,
    private readonly threshold: LogLevel,
    private readonly sink: (level: Exclude<LogLevel, "silent">, message: string, args: unknown[]) => void = defaultSink,
  ) {}

  child(prefix: string): PluginLogger {
    return new ConsoleLogger(`${this.prefix}:${prefix}`, this.threshold, this.sink);
  }

  debug(message: string, ...args: unknown[]): void {
    this.log("debug", message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log("info", message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log("warn", message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log("error", message, args);
  }

  private log(level: Exclude<LogLevel, "silent">, message: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] >= LEVEL_ORDER[this.threshold]) {
      this.sink(level, `[${this.prefix}] ${message}`, args);
    }
  }
}

function defaultSink(level: Exclude<LogLevel, "silent">, message: string, args: unknown[]): void {
  const fn = level === "debug" ? console.debug : level === "info" ? console.info : level === "warn" ? console.warn : console.error;
  fn(message, ...args);
}
