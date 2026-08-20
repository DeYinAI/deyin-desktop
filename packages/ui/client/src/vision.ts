import type { ModelInfo } from "@deyin/contract";

export interface VisionRouteResult {
  /** Model the run should use. */
  model: string;
  /** Set when the selected model lacks vision and a capable one took over. */
  routedTo?: string;
}

/**
 * Decide which model runs when the user attached images:
 * - selected model known vision-capable → use it;
 * - selected model known NOT vision-capable → first vision model in the list
 *   (for the primary provider that list is exactly what the user's plan allows);
 * - no vision-capable model at all → null (caller shows a friendly error);
 * - capability unknown (no metadata) → keep the selection and let the API decide.
 */
export function resolveVisionModel(models: ModelInfo[], selectedModel: string): VisionRouteResult | null {
  const selected = models.find((m) => m.id === selectedModel);
  if (!selected || selected.vision !== false) return { model: selectedModel };
  const alt = models.find((m) => m.vision === true);
  if (!alt) return null;
  return { model: alt.id, routedTo: alt.id };
}
