import type { ModelInfo } from "@deyin/contract";

export interface VisionRouteResult {
  /** Model the run should use. */
  model: string;
  /** Set when the selected model lacks vision and a capable one took over. */
  routedTo?: string;
}

export interface ResolveVisionModelOptions {
  /** When false (default), do not auto-switch to a cloud vision model. */
  autoRoute?: boolean;
}

/**
 * Decide which model runs when the user attached images:
 * - selected model known vision-capable → use it;
 * - selected model known NOT vision-capable → first vision model in the list when
 *   autoRoute is true (for the primary provider that list is the user's plan);
 * - autoRoute false and text-only selection → null (caller may use Local Vision);
 * - no vision-capable model at all → null (caller shows a friendly error);
 * - capability unknown (no metadata) → keep the selection and let the API decide.
 */
export function resolveVisionModel(
  models: ModelInfo[],
  selectedModel: string,
  opts?: ResolveVisionModelOptions,
): VisionRouteResult | null {
  const autoRoute = opts?.autoRoute ?? false;
  const selected = models.find((m) => m.id === selectedModel);
  if (!selected || selected.vision !== false) return { model: selectedModel };
  if (!autoRoute) return null;
  const alt = models.find((m) => m.vision === true);
  if (!alt) return null;
  return { model: alt.id, routedTo: alt.id };
}

export const LOCAL_VISION_PLUGIN = "local-vision";

/** User-facing hint when images cannot be sent on the current model. */
export function visionBlockedMessage(opts?: { localVisionAvailable?: boolean }): string {
  const localHint = opts?.localVisionAvailable
    ? "install the **Local Vision** plugin (Settings → Capabilities → Plugins) and run `ollama pull moondream` (~1.7 GB), or "
    : "";
  return (
    "This model can't read images. Pick a vision model from the model menu, turn on " +
    "**Auto route to cloud vision** in Settings → General, or " +
    localHint +
    "remove the attached images."
  );
}
