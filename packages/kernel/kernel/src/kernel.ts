import {
  type ConfigLayer,
  type HostEnvironment,
  type PluginContext,
  type PluginDefinition,
  type PluginState,
  type PluginStatus,
  type ResolvedConfig,
  type ServiceKey,
} from "@deyin/extension-api";
import { resolveConfig } from "./config.js";
import { ConsoleLogger, type LogLevel } from "./logger.js";
import { createRegistration, EventBus, type ServiceEntry, ScopeImpl } from "./scope.js";

export interface KernelOptions {
  readonly env: HostEnvironment;
  /** Minimum log level for the kernel logger. Default "info". */
  readonly logLevel?: LogLevel;
  readonly logger?: (level: LogLevel, message: string, args: unknown[]) => void;
}

interface PluginRecord {
  readonly def: PluginDefinition;
  state: PluginState;
  error?: string;
  source?: string;
  config?: unknown;
  /** Root scope for this plugin's registrations; null until activated. */
  activationScope: ScopeImpl | undefined;
}

/**
 * The plugin kernel. Hosts create one per process (desktop main, web session,
 * CLI run), register plugin definitions, and `start()` with config layers.
 *
 * Guarantees:
 * - Load order is a pure function of metadata: `provides`/`inject` edges with
 *   config-row order as tiebreak. Cycles fail every member in isolation.
 * - One broken plugin never breaks the host: apply() errors mark that plugin
 *   failed, unwind only its registrations, and loading continues.
 * - Disposal runs in reverse activation order and always runs, even if a
 *   cleanup throws.
 */
export class PluginKernel {
  private readonly definitions = new Map<string, PluginDefinition>();
  private readonly records = new Map<string, PluginRecord>();
  private readonly bus = new EventBus();
  private readonly logger: ConsoleLogger;
  /** Shared service storage: the root scope and every plugin context. */
  private readonly rootStorage = new Map<string, ServiceEntry>();
  private readonly rootScope: ScopeImpl;
  /** Successful activations, in order — disposal walks this backwards. */
  private readonly activated: PluginRecord[] = [];
  private resolved: ResolvedConfig | undefined;

  constructor(options: KernelOptions) {
    this.logger = new ConsoleLogger("kernel", options.logLevel ?? "info", options.logger);
    // The root registration is shared by kernel-level registrations only.
    const rootRegistration = createRegistration("kernel");
    this.rootScope = new ScopeImpl(
      "root",
      undefined,
      this.bus,
      rootRegistration,
      options.env,
      this.logger,
      this.rootStorage,
    );
    this.bus.setEmitHook((event) => this.wakeLazyPlugins(event));
  }

  /** Register a plugin definition. Duplicate names are a host bug: throw. */
  register(def: PluginDefinition): this {
    if (this.definitions.has(def.name)) {
      throw new Error(`plugin "${def.name}" is already registered`);
    }
    this.definitions.set(def.name, def);
    this.records.set(def.name, { def, state: "registered", activationScope: undefined });
    return this;
  }

  /**
   * Resolve the config layers and activate every selected eager plugin in
   * dependency order. Lazy plugins (activateOn) stay dormant until a
   * matching event fires. Resolves when eager activation completes.
   */
  async start(layers: readonly ConfigLayer[]): Promise<PluginStatus[]> {
    if (this.resolved) throw new Error("kernel already started");
    this.resolved = resolveConfig(layers);

    const selected: PluginRecord[] = [];
    for (const row of this.resolved.rows) {
      const record = this.records.get(row.plugin);
      if (!record) {
        this.logger.warn(`config row "${row.id}" names unknown plugin "${row.plugin}"`);
        continue;
      }
      record.config = row.config;
      record.source = this.resolved.provenance.get(row.id);
      selected.push(record);
    }

    for (const record of orderPlugins(selected, this.logger)) {
      if (record.def.applies && !record.def.applies(this.rootScope.env)) continue;
      if (record.def.activateOn && record.def.activateOn.length > 0) {
        record.state = "lazy";
        continue;
      }
      // A provider that already failed at runtime takes its dependents down
      // with a clear error instead of letting them hit a missing service.
      const failedDep = (record.def.inject ?? []).find((serviceId) => this.serviceState(serviceId) === "failed");
      if (failedDep) {
        record.state = "failed";
        record.error = `unresolvable dependencies (${failedDep})`;
        this.logger.error(`plugin "${record.def.name}" failed: ${record.error}`);
        this.bus.emit("kernel:plugin:failed", { name: record.def.name, error: record.error });
        continue;
      }
      await this.activate(record);
    }
    return this.status();
  }

  private serviceState(serviceId: string): PluginState | undefined {
    for (const record of this.records.values()) {
      if (record.def.provides?.includes(serviceId)) return record.state;
    }
    return undefined;
  }

  private async activate(record: PluginRecord): Promise<void> {
    const { def } = record;
    const registration = createRegistration(def.name);
    // Shares the root's service storage so providers are visible to every
    // other plugin; ownership stays per-plugin for isolation on dispose.
    const scope = new ScopeImpl(
      def.name,
      this.rootScope,
      this.bus,
      registration,
      this.rootScope.env,
      this.logger.child(def.name),
      this.rootStorage,
    );
    record.activationScope = scope;
    try {
      await def.apply(scope, record.config);
      record.state = "active";
      this.activated.push(record);
      this.logger.info(`activated ${def.name}`);
      this.bus.emit("kernel:plugin:activated", { name: def.name });
    } catch (err) {
      // Isolate: unwind only this plugin, keep loading the rest.
      await this.disposeRecord(record);
      record.state = "failed";
      record.error = err instanceof Error ? err.message : String(err);
      record.activationScope = undefined;
      this.logger.error(`plugin "${def.name}" failed: ${record.error}`);
      this.bus.emit("kernel:plugin:failed", { name: def.name, error: record.error });
    }
  }

  /** Activate lazy plugins whose activateOn matches `event` (exact or prefix*). */
  private wakeLazyPlugins(event: string): void {
    for (const record of this.records.values()) {
      if (record.state !== "lazy") continue;
      const match = record.def.activateOn?.find((pattern) => matchesActivation(pattern, event));
      if (!match) continue;
      record.state = "registered"; // eager path from here
      void this.activate(record).then(() => {
        if (record.state === "active") {
          this.bus.emit("kernel:plugin:lazy-activated", { name: record.def.name, event });
        }
      });
    }
  }

  private async disposeRecord(record: PluginRecord): Promise<void> {
    const scope = record.activationScope;
    if (!scope) return;
    record.activationScope = undefined;
    try {
      await scope.dispose();
    } catch (err) {
      this.logger.error(`cleanup for "${record.def.name}" failed:`, err);
    }
    const index = this.activated.indexOf(record);
    if (index >= 0) this.activated.splice(index, 1);
    this.bus.emit("kernel:plugin:disposed", { name: record.def.name });
  }

  /** Shut the kernel down: plugins in reverse activation order. */
  async dispose(): Promise<void> {
    while (this.activated.length > 0) {
      const record = this.activated[this.activated.length - 1];
      if (!record) break;
      await this.disposeRecord(record);
      record.state = "disposed";
    }
  }

  /** Snapshot for the Plugins settings page / diagnostics. */
  status(): PluginStatus[] {
    return [...this.records.values()].map((record) => ({
      name: record.def.name,
      state: record.state,
      error: record.error,
      source: record.source,
    }));
  }

  /**
   * Activate one plugin now — the programmatic path for lazy plugins whose
   * activation is a host decision (e.g. a settings toggle) rather than an
   * event pattern. No-op if already active; throws for unknown names.
   */
  async activatePlugin(name: string): Promise<PluginStatus> {
    const record = this.records.get(name);
    if (!record) throw new Error(`unknown plugin "${name}"`);
    if (record.state !== "active" && record.state !== "failed") {
      await this.activate(record);
    }
    const status = this.status().find((s) => s.name === name);
    if (!status) throw new Error(`unknown plugin "${name}"`);
    return status;
  }

  /** Dispose one plugin (e.g. its setting was toggled off); the host continues. */
  async disposePlugin(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) throw new Error(`unknown plugin "${name}"`);
    await this.disposeRecord(record);
    if (record.state !== "failed") record.state = "disposed";
  }

  /** The resolved plugin tree, for --dump-config style diagnostics. */
  dumpConfig(): ResolvedConfig & { plugins: PluginStatus[] } {
    if (!this.resolved) throw new Error("kernel not started");
    return { ...this.resolved, plugins: this.status() };
  }

  // Root-context passthrough for the host process.
  get<T>(key: ServiceKey<T>): T {
    return this.rootScope.get(key);
  }

  tryGet<T>(key: ServiceKey<T>): T | undefined {
    return this.rootScope.tryGet(key);
  }

  get context(): PluginContext {
    return this.rootScope;
  }
}

/**
 * Stable topological sort over provides → inject edges; config-row order is
 * the tiebreak so a config swap changes behavior deterministically. Cycle
 * members fail in isolation with a message naming the cycle.
 */
function orderPlugins(selected: readonly PluginRecord[], logger: ConsoleLogger): PluginRecord[] {
  const providerOf = new Map<string, PluginRecord>();
  for (const record of selected) {
    for (const serviceId of record.def.provides ?? []) {
      const existing = providerOf.get(serviceId);
      if (existing && existing !== record) {
        failIsolated(record, `service "${serviceId}" has two providers: "${existing.def.name}" and "${record.def.name}"`, logger);
      } else {
        providerOf.set(serviceId, record);
      }
    }
  }

  const waiting = selected.filter((r) => r.state === "registered");
  const ordered: PluginRecord[] = [];
  const remaining = [...waiting];
  let progress = true;
  while (remaining.length > 0 && progress) {
    progress = false;
    for (let i = 0; i < remaining.length; ) {
      const record = remaining[i];
      if (!record) break;
      const unmet = (record.def.inject ?? []).filter((serviceId) => {
        const provider = providerOf.get(serviceId);
        return !provider || provider.state === "failed" || !ordered.includes(provider);
      });
      if (unmet.length === 0) {
        ordered.push(record);
        remaining.splice(i, 1);
        progress = true;
      } else {
        i += 1;
      }
    }
  }

  // Whatever is left is cyclic (or depends on a cycle).
  for (const record of remaining) {
    const deps = (record.def.inject ?? []).join(", ");
    failIsolated(record, `unresolvable dependencies (${deps || "cycle detected"})`, logger);
  }
  return ordered;
}

function failIsolated(record: PluginRecord, message: string, logger: ConsoleLogger): void {
  record.state = "failed";
  record.error = message;
  logger.error(`plugin "${record.def.name}" failed: ${message}`);
}

/** Exact match or `prefix*` wildcard, dsh-style activation patterns. */
export function matchesActivation(pattern: string, event: string): boolean {
  if (pattern.endsWith("*")) return event.startsWith(pattern.slice(0, -1));
  return pattern === event;
}
