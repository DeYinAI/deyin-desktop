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
 * Decide which model runs when the user attached images.
 * Images are always sent to the selected model when it is vision-capable or
 * its capability is unknown — the provider, not the client, is the authority
 * on what it accepts, and its errors surface in the timeline like any other.
 * The one client-side reroute is opt-in: when the selected model is *known*
 * text-only and auto-route is on, the first vision model in the list takes the
 * message. Never returns null.
 */
export function resolveVisionModel(
  models: ModelInfo[],
  selectedModel: string,
  opts?: ResolveVisionModelOptions,
): VisionRouteResult {
  const autoRoute = opts?.autoRoute ?? false;
  const selected = models.find((m) => m.id === selectedModel);
  if (!selected || selected.vision !== false) return { model: selectedModel };
  if (!autoRoute) return { model: selectedModel };
  const alt = models.find((m) => m.vision === true);
  if (!alt) return { model: selectedModel };
  return { model: alt.id, routedTo: alt.id };
}

export const LOCAL_VISION_PLUGIN = "local-vision";
