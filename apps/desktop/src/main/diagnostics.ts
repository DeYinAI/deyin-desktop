import { randomUUID } from "node:crypto";
import { app } from "electron";
import {
  detectEnv,
  machineId,
  redactObject,
  redactText,
  sendDiagnosticsReport,
  workspaceFingerprint,
  type DiagnosticsPayload,
  type DiagnosticsResult,
  type SettingsStore,
  type Storage,
  type UsageStore,
} from "@deyin/host-core";
import type { DeyinConfig } from "@deyin/contract";
import type { AuthManager } from "./auth.js";
import { getLogger, logLine } from "./logger.js";

/** Cap on the log tail so uploads stay small. */
const LOG_TAIL_BYTES = 64_000;

interface DiagnosticsServiceOptions {
  storage: Storage;
  config: DeyinConfig;
  auth: AuthManager;
  settings: SettingsStore;
  usage: UsageStore;
  getWorkspaceRoot: () => string | null;
}

/**
 * Builds and uploads the diagnostics bundle used for "send data to Openference"
 * support flows. The bundle is pseudonymous (fingerprint + random install id),
 * secret-scrubbed, and only includes usage counters when telemetry is enabled.
 */
export class DiagnosticsService {
  constructor(private readonly opts: DiagnosticsServiceOptions) {}

  async send(note?: string): Promise<DiagnosticsResult> {
    const { auth, config, settings, usage, storage } = this.opts;
    if (!(await auth.getUser())) return { ok: false, message: "Sign in to send diagnostics." };

    const [env, id] = await Promise.all([detectEnv(), machineId()]);
    const installId = storage.readJson<{ installId: string }>("telemetry.json", { installId: "" }).installId;
    const { totalTokens, sessions, messages, activeDays } = usage.stats();
    const trimmedNote = note?.trim();

    const payload: DiagnosticsPayload = {
      reportId: `diag_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      fingerprintFull: workspaceFingerprint(id, this.opts.getWorkspaceRoot()),
      installId,
      env: { platform: env.platform, arch: env.arch, wsl2: env.wsl2, defaultShell: env.defaultShell },
      settings: redactObject<Record<string, unknown>>({ ...settings.get() }),
      logTail: redactText(getLogger()?.tail(LOG_TAIL_BYTES) ?? ""),
      // Anonymous counters only when the user opted into telemetry.
      ...(settings.get().telemetry ? { usageStats: { totalTokens, sessions, messages, activeDays } } : {}),
      ...(trimmedNote ? { note: trimmedNote.slice(0, 2000) } : {}),
    };

    const result = await sendDiagnosticsReport(config, () => auth.getAccessToken(), payload);
    logLine(
      result.ok ? "info" : "warn",
      `[diagnostics] report ${payload.reportId} ${result.ok ? "sent" : `failed: ${result.message ?? "unknown"}`}`,
    );
    return { ...result, reportId: result.reportId ?? (result.ok ? payload.reportId : undefined) };
  }
}
