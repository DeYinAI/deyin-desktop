import { mkdirSync, readFileSync, renameSync, statSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

/**
 * Rotating app log at <dir>/deyin.log. Small and dependency-free: writes are
 * appended synchronously (logging must never block or crash the app), and the
 * file rotates through deyin.1.log … deyin.N-1.log once it passes maxBytes.
 * This is the file the "Copy log path" menu and diagnostics upload read.
 */
export class Logger {
  readonly filePath: string;
  private size = 0;
  private failed = false;

  constructor(
    readonly dir: string,
    private readonly opts: { maxBytes?: number; maxFiles?: number } = {},
  ) {
    this.filePath = join(dir, "deyin.log");
    try {
      mkdirSync(dir, { recursive: true });
      this.size = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    } catch {
      this.failed = true;
    }
  }

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  write(level: LogLevel, message: string): void {
    if (this.failed) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`;
    try {
      const maxBytes = this.opts.maxBytes ?? 1_000_000;
      if (this.size + line.length > maxBytes && this.size > 0) this.rotate();
      appendFileSync(this.filePath, line, { encoding: "utf8" });
      this.size += line.length;
    } catch {
      this.failed = true;
    }
  }

  /** Last `maxBytes` of the current log, for diagnostics bundles. */
  tail(maxBytes: number): string {
    try {
      if (!existsSync(this.filePath)) return "";
      const size = statSync(this.filePath).size;
      const content = readFileSync(this.filePath, "utf8");
      if (size <= maxBytes) return content;
      // Drop the first partial line so the tail starts at a line boundary.
      return content.slice(size - maxBytes).replace(/^[^\n]*\n/, "");
    } catch {
      return "";
    }
  }

  private rotate(): void {
    const maxFiles = Math.max(1, this.opts.maxFiles ?? 3);
    // Shift deyin.N-1.log -> deyin.N.log so the oldest generation drops off.
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = join(this.dir, `deyin.${i}.log`);
      const to = join(this.dir, `deyin.${i + 1}.log`);
      try {
        if (existsSync(from)) renameSync(from, to);
      } catch {
        // keep going; losing an old generation beats losing the new log
      }
    }
    try {
      renameSync(this.filePath, join(this.dir, "deyin.1.log"));
    } catch {
      // first write will recreate the file
    }
    this.size = 0;
  }
}
