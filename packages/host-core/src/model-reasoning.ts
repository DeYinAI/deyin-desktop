import type { DeyinSettings } from "./types.js";

export type ModelReasoningMode = "off" | "low" | "medium" | "high";

export const MODEL_REASONING_MODES: ReadonlyArray<{ id: ModelReasoningMode; label: string }> = [
  { id: "off", label: "Off" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Med" },
  { id: "high", label: "High" },
];

/** Stable settings key for a provider + model pair. */
export function modelEffortKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function parseModelEffortKey(key: string): { providerId: string; modelId: string } | null {
  const sep = key.indexOf("::");
  if (sep <= 0 || sep >= key.length - 2) return null;
  return { providerId: key.slice(0, sep), modelId: key.slice(sep + 2) };
}

export interface StoredModelSelection {
  providerId: string;
  modelId: string;
}

/** Parse a persisted `"providerId::modelId"` value (bare ids use `fallbackProvider`). */
export function parseStoredModelRef(
  ref: string | null | undefined,
  fallbackProvider = "openference",
): StoredModelSelection | null {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const sep = trimmed.indexOf("::");
  if (sep < 0) return { providerId: fallbackProvider, modelId: trimmed };
  const providerId = trimmed.slice(0, sep).trim();
  const modelId = trimmed.slice(sep + 2).trim();
  if (!modelId) return null;
  return { providerId: providerId || fallbackProvider, modelId };
}

export function formatStoredModelRef(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function isModelReasoningMode(value: unknown): value is ModelReasoningMode {
  return value === "off" || value === "low" || value === "medium" || value === "high";
}

/** Read the saved reasoning mode for a model, or undefined when inheriting defaults. */
export function getModelReasoningMode(
  settings: Pick<DeyinSettings, "modelEfforts">,
  providerId: string,
  modelId: string,
): ModelReasoningMode | undefined {
  const saved = settings.modelEfforts[modelEffortKey(providerId, modelId)];
  return isModelReasoningMode(saved) ? saved : undefined;
}

/** Resolve wire-level thinking + effort for a run from per-model overrides and global defaults. */
export function resolveModelReasoning(
  settings: Pick<DeyinSettings, "thinking" | "modelEfforts">,
  providerId: string,
  modelId: string,
): { thinking: boolean; effort?: "low" | "medium" | "high" } {
  const mode = getModelReasoningMode(settings, providerId, modelId);
  if (mode === "off") return { thinking: false };
  if (mode === "low" || mode === "medium" || mode === "high") {
    return { thinking: true, effort: mode };
  }
  return { thinking: settings.thinking };
}

export function reasoningModeLabel(
  settings: Pick<DeyinSettings, "thinking" | "modelEfforts">,
  providerId: string,
  modelId: string,
): string {
  const mode = getModelReasoningMode(settings, providerId, modelId);
  if (mode) return MODEL_REASONING_MODES.find((m) => m.id === mode)?.label ?? mode;
  return settings.thinking ? "Auto" : "Off";
}
