/**
 * Opt-in anonymous usage telemetry. Events carry only a feature name and coarse
 * properties — never code, file paths, prompts or identifiers beyond a random
 * install id. When the endpoint is unreachable the buffer is dropped (offline
 * drop): telemetry must never queue up or block the app.
 */

export interface TelemetryEventProps {
  [key: string]: string | number | boolean;
}

export interface TelemetryEvent {
  name: string;
  at: string;
  props?: TelemetryEventProps;
}

export interface TelemetryReporterOptions {
  /** POST target, e.g. `${oauthIssuer}/api/telemetry`. */
  endpoint: string;
  /** Read live so toggling the setting takes effect without a restart. */
  isEnabled: () => boolean;
  /** Random id persisted by the host; identifies an install, not a person. */
  installId: string;
  appVersion: string;
  platform: string;
  /** Flush interval in ms (default 60s). */
  flushIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

const MAX_BUFFER = 100;

export class TelemetryReporter {
  private buffer: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: TelemetryReporterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Queue one event; silently ignored while telemetry is off. */
  record(name: string, props?: TelemetryEventProps): void {
    if (!this.opts.isEnabled()) return;
    this.buffer.push({ name, at: new Date().toISOString(), ...(props ? { props } : {}) });
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
  }

  /** Send the buffer; on any failure the events are dropped, never retried. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.opts.isEnabled()) {
      this.buffer = [];
      return;
    }
    const events = this.buffer;
    this.buffer = [];
    try {
      await this.fetchImpl(this.opts.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installId: this.opts.installId,
          appVersion: this.opts.appVersion,
          platform: this.opts.platform,
          events,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Offline drop by design.
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs ?? 60_000);
    // Never keep the process alive just for telemetry.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
