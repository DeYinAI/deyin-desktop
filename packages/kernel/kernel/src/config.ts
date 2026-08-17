import type { ConfigLayer, PluginConfigRow, ResolvedConfig } from "@deyin/extension-api";

/**
 * Resolve ordered config layers into one plugin row set. Later layers patch
 * earlier rows by id: "merge" replaces only the declared fields, "replace"
 * swaps the whole row. Rows disabled by any layer drop out of `rows` but stay
 * in `provenance` so dump-config can show who killed them.
 */
export function resolveConfig(layers: readonly ConfigLayer[]): ResolvedConfig {
  const merged = new Map<string, PluginConfigRow>();
  const provenance = new Map<string, string>();

  for (const layer of layers) {
    for (const row of layer.rows) {
      const previous = merged.get(row.id);
      provenance.set(row.id, layer.name);
      if (layer.mode === "replace" || !previous) {
        merged.set(row.id, { ...row });
        continue;
      }
      merged.set(row.id, {
        ...previous,
        ...row,
        config: row.config !== undefined ? row.config : previous.config,
      });
    }
  }

  const rows = [...merged.values()].filter((row) => row.enabled !== false);
  return {
    layers: layers.map((l) => l.name),
    rows,
    provenance,
  };
}
