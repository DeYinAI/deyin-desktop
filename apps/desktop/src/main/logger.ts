import { Logger, redactText, type LogLevel } from "@deyin/host-core";

/**
 * Main-process logging: a process-wide Logger writing <logs>/deyin.log, with the
 * console methods mirrored into it so every existing console.log/warn/error
 * (auth, updater, agent host, …) lands in the file without call-site changes.
 * Renderer lines arrive over IPC (CH.logWrite). Scrubbed on write so tokens in
 * OAuth callback URLs never persist to disk.
 */
let logger: Logger | null = null;

/** Create the file logger and mirror console.* into it. Call once, early. */
export function initLogger(logsDir: string): Logger {
  if (logger) return logger;
  logger = new Logger(logsDir);

  const original = { log: console.log, warn: console.warn, error: console.error };
  const wrap = (level: LogLevel, fn: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      fn(...args);
      writeToFile(level, args);
    };
  console.log = wrap("info", original.log);
  console.warn = wrap("warn", original.warn);
  console.error = wrap("error", original.error);

  process.on("uncaughtException", (err) => {
    writeToFile("error", [`uncaughtException: ${err.stack ?? err.message}`]);
  });
  process.on("unhandledRejection", (reason) => {
    writeToFile("error", [`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`]);
  });

  logger.info(`logger initialized at ${logger.filePath}`);
  return logger;
}

/** Append a line from any source; safe before initLogger (drops to nowhere). */
export function logLine(level: LogLevel, message: string): void {
  logger?.write(level, redactText(message));
}

/** The active logger (null until initLogger runs). */
export function getLogger(): Logger | null {
  return logger;
}

function writeToFile(level: LogLevel, args: unknown[]): void {
  if (!logger) return;
  const message = args
    .map((arg) => {
      if (arg instanceof Error) return arg.stack ?? arg.message;
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
  logger.write(level, redactText(message));
}
