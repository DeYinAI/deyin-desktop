/**
 * Config-layer composition — how a running Deyin process decides which
 * plugins load. A process is a list of plugin *rows* resolved from ordered
 * layers; later layers patch earlier ones by row id (replace, disable, or
 * supply config), mirroring dsh's bundle → profile → patch stack.
 */

export interface PluginConfigRow {
  /** Stable row id used to target the row from later layers. */
  id: string;
  /** PluginDefinition.name this row activates. */
  plugin: string;
  /** Default true; false removes the plugin from the resolved set. */
  enabled?: boolean;
  /** Plugin-specific config passed as `apply(ctx, config)`. */
  config?: unknown;
}

/** One layer of the composition stack, e.g. bundle-base, profile, user patch. */
export interface ConfigLayer {
  /** Layer name for diagnostics: "bundle:base", "profile:desktop", "user". */
  name: string;
  /**
   * How rows combine with earlier layers carrying the same id:
   * - "merge" (default): replace declared fields, keep the rest of the row.
   * - "replace": the row wholly replaces the earlier one.
   */
  mode?: "merge" | "replace";
  rows: PluginConfigRow[];
}

export interface ResolvedConfig {
  /** Every layer that contributed, in application order. */
  readonly layers: readonly string[];
  /** Rows surviving the merge, in stable order. */
  readonly rows: readonly PluginConfigRow[];
  /** Layer that last touched each row id, for --dump-config provenance. */
  readonly provenance: ReadonlyMap<string, string>;
}
