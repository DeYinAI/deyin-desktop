/**
 * The shared event map. Kernel lifecycle events are declared here; capability
 * seams extend the same interface via module augmentation so every event in
 * the process is typed in one place:
 *
 * ```ts
 * declare module "@deyin/extension-api" {
 *   interface PluginEvents {
 *     "tools:registered": { name: string };
 *   }
 * }
 * ```
 */
export interface PluginEvents {
  /** A plugin finished applying successfully. */
  "kernel:plugin:activated": { name: string };
  /** A plugin failed to apply and was isolated (host keeps running). */
  "kernel:plugin:failed": { name: string; error: string };
  /** A plugin was disposed (manually or during kernel shutdown). */
  "kernel:plugin:disposed": { name: string };
  /** A lazily-activating plugin was activated by a matching event. */
  "kernel:plugin:lazy-activated": { name: string; event: string };
}

export type EventName = keyof PluginEvents | (string & {});
export type EventPayload<E extends EventName> = E extends keyof PluginEvents ? PluginEvents[E] : never;
export type EventListener<E extends EventName> = (payload: EventPayload<E>) => void | Promise<void>;

/**
 * Waterfall middleware: receives the current value and returns the value to
 * pass onward. Executed sequentially in registration order; async allowed.
 * Used for request/tool interception (`tools/pre-execute`, `llm/request`).
 */
export type WaterfallListener<T> = (value: T) => T | Promise<T>;

export type Unsubscribe = () => void;
