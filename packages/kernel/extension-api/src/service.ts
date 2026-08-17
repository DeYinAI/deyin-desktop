/**
 * Service keys — the seam identifiers plugins use to find each other.
 *
 * A capability seam is a `ServiceKey<T>` created once by the seam owner
 * (e.g. `tools`, `llm`) and imported by every consumer. The key carries the
 * interface type; the kernel resolves it to whichever provider plugin is
 * active in the current scope. Consumers never import a concrete provider.
 */

export interface ServiceKey<T> {
  /** Stable identifier, e.g. "tools", "llm", "shell". Matches `inject` entries. */
  readonly id: string;
  /** Human-facing description shown by diagnostics. */
  readonly description?: string;
  /**
   * Providers that must be ready before a consumer's `apply` runs. Usually
   * empty; `"required"` means the kernel refuses to activate consumers of
   * this service until at least one provider exists.
   */
  readonly required?: boolean;
  /** Phantom field carrying the service type — never assigned at runtime. */
  readonly __serviceType?: T;
}

let nextAnonymousId = 0;

export function defineService<T>(id?: string, description?: string): ServiceKey<T> {
  return {
    id: id ?? `anonymous-service-${nextAnonymousId++}`,
    description,
  };
}
