import type {
  EventListener,
  EventName,
  EventPayload,
  HostEnvironment,
  PluginLogger,
  PluginScope,
  ServiceKey,
  Unsubscribe,
  WaterfallListener,
} from "@deyin/extension-api";

/**
 * Per-plugin and per-scope bookkeeping. Everything a plugin registers —
 * services, listeners, waterfall middleware, effects — is owned by its
 * registration, so a failing or disposed plugin unwinds exactly its own
 * footprint.
 */
export interface PluginRegistration {
  readonly pluginName: string;
  /** Services this plugin provided, removed from their scope on dispose. */
  readonly providedServices: { scope: ScopeImpl; id: string }[];
  readonly unsubscribes: Unsubscribe[];
  /** LIFO cleanups registered via ctx.effect(). */
  readonly effects: Array<() => void | Promise<void>>;
}

export function createRegistration(pluginName: string): PluginRegistration {
  return { pluginName, providedServices: [], unsubscribes: [], effects: [] };
}

export interface ServiceEntry {
  readonly value: unknown;
  /** Owning plugin name, for duplicate-provider errors. */
  readonly owner: string;
}

export class DuplicateServiceError extends Error {
  constructor(serviceId: string, owner: string) {
    super(`service "${serviceId}" is already provided by "${owner}"`);
    this.name = "DuplicateServiceError";
  }
}

export class MissingServiceError extends Error {
  constructor(serviceId: string) {
    super(`no provider for service "${serviceId}" is active in this scope`);
    this.name = "MissingServiceError";
  }
}

type EventSubscription = { listener: (payload: unknown) => unknown; plugin: string };
type WaterfallSubscription = { listener: (value: never) => never | Promise<never>; plugin: string };

/**
 * A context bound to one registration. The kernel hands each plugin one of
 * these rooted at the kernel scope. All plugin activation contexts share the
 * root's service storage (so providers are visible across plugins, with
 * per-plugin ownership for disposal); `scope()` creates children with fresh
 * storage for scoped registration (most-specific scope wins on lookup).
 */
export class ScopeImpl implements PluginScope {
  readonly children: ScopeImpl[] = [];
  readonly pluginName: string;

  constructor(
    scopeName: string,
    private readonly parentScope: ScopeImpl | undefined,
    private readonly bus: EventBus,
    private readonly registration: PluginRegistration,
    readonly env: HostEnvironment,
    readonly logger: PluginLogger,
    /** Service storage this scope reads/writes; plugin contexts share the root's. */
    private readonly services: Map<string, ServiceEntry> = new Map(),
  ) {
    this.scopeName = scopeName;
    this.pluginName = registration.pluginName;
  }

  readonly scopeName: string;

  get<T>(key: ServiceKey<T>): T {
    const value = this.tryGet(key);
    if (value === undefined) throw new MissingServiceError(key.id);
    return value;
  }

  tryGet<T>(key: ServiceKey<T>): T | undefined {
    for (let scope: ScopeImpl | undefined = this; scope; scope = scope.parentScope) {
      const entry = scope.services.get(key.id);
      if (entry) return entry.value as T;
    }
    return undefined;
  }

  provide<T>(key: ServiceKey<T>, value: T | (() => T)): void {
    const existing = this.services.get(key.id);
    if (existing) {
      throw new DuplicateServiceError(key.id, existing.owner);
    }
    const resolved = typeof value === "function" ? (value as () => T)() : value;
    this.services.set(key.id, { value: resolved, owner: this.pluginName });
    this.registration.providedServices.push({ scope: this, id: key.id });
  }

  on<E extends EventName>(event: E, listener: EventListener<E>): Unsubscribe {
    const unsub = this.bus.on(event, listener as EventSubscription["listener"], this.pluginName);
    this.registration.unsubscribes.push(unsub);
    return unsub;
  }

  once<E extends EventName>(event: E, listener: EventListener<E>): Unsubscribe {
    let disposed = false;
    let off: Unsubscribe = () => {};
    off = this.bus.on(
      event,
      (payload) => {
        if (!disposed) {
          disposed = true;
          off();
        }
        return (listener as EventSubscription["listener"])(payload);
      },
      this.pluginName,
    );
    this.registration.unsubscribes.push(off);
    return off;
  }

  emit<E extends EventName>(event: E, payload: EventPayload<E>): void {
    this.bus.emit(event, payload);
  }

  onWaterfall<T>(event: EventName, listener: WaterfallListener<T>): Unsubscribe {
    const unsub = this.bus.onWaterfall(event, listener as WaterfallSubscription["listener"], this.pluginName);
    this.registration.unsubscribes.push(unsub);
    return unsub;
  }

  waterfall<T>(event: EventName, seed: T): Promise<T> {
    return this.bus.waterfall(event, seed);
  }

  effect(cleanup: () => void | Promise<void>): void {
    this.registration.effects.push(cleanup);
  }

  scope(name: string): PluginScope {
    const child = new ScopeImpl(
      name,
      this,
      this.bus,
      createRegistration(this.pluginName),
      this.env,
      this.logger.child(name),
      // Fresh storage: child provides shadow the parent chain, never leak up.
      new Map(),
    );
    this.children.push(child);
    return child;
  }

  async dispose(): Promise<void> {
    // Child scopes first, deepest to shallowest.
    for (const child of this.children.splice(0)) {
      await child.dispose();
    }
    // Effects LIFO.
    while (this.registration.effects.length > 0) {
      const effect = this.registration.effects.pop();
      if (effect) await effect();
    }
    for (const unsub of this.registration.unsubscribes.splice(0)) unsub();
    for (const { scope, id } of this.registration.providedServices.splice(0)) {
      if (scope.services.get(id)?.owner === this.pluginName) scope.services.delete(id);
    }
  }
}

/**
 * Process-wide event bus. `emit` also drives lazy activation: the kernel
 * installs a hook here to match pending activateOn patterns.
 */
export class EventBus {
  private readonly listeners = new Map<string, EventSubscription[]>();
  private readonly waterfalls = new Map<string, WaterfallSubscription[]>();
  private emitHook: ((event: string, payload: unknown) => void) | undefined;

  /** Kernel installs the lazy-activation matcher here. */
  setEmitHook(hook: (event: string, payload: unknown) => void): void {
    this.emitHook = hook;
  }

  on(event: string, listener: EventSubscription["listener"], plugin: string): Unsubscribe {
    const list = this.listeners.get(event) ?? [];
    list.push({ listener, plugin });
    this.listeners.set(event, list);
    return () => {
      const current = this.listeners.get(event);
      if (!current) return;
      const index = current.findIndex((sub) => sub.listener === listener);
      if (index >= 0) current.splice(index, 1);
    };
  }

  onWaterfall(event: string, listener: WaterfallSubscription["listener"], plugin: string): Unsubscribe {
    const list = this.waterfalls.get(event) ?? [];
    list.push({ listener, plugin });
    this.waterfalls.set(event, list);
    return () => {
      const current = this.waterfalls.get(event);
      if (!current) return;
      const index = current.findIndex((sub) => sub.listener === listener);
      if (index >= 0) current.splice(index, 1);
    };
  }

  emit(event: string, payload: unknown): void {
    this.emitHook?.(event, payload);
    for (const { listener } of [...(this.listeners.get(event) ?? [])]) {
      try {
        const result = listener(payload);
        if (result instanceof Promise) {
          result.catch((err) => {
            console.error(`[kernel] async event listener for "${event}" failed:`, err);
          });
        }
      } catch (err) {
        console.error(`[kernel] event listener for "${event}" failed:`, err);
      }
    }
  }

  async waterfall<T>(event: string, seed: T): Promise<T> {
    let value = seed;
    for (const { listener, plugin } of [...(this.waterfalls.get(event) ?? [])]) {
      try {
        value = (await listener(value as never)) as T;
      } catch (err) {
        console.error(`[kernel] waterfall "${event}" middleware from "${plugin}" failed:`, err);
      }
    }
    return value;
  }
}
