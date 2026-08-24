import type { DeyinSettings, ModelReasoningMeta } from "./types.js";

export type ModelReasoningMode = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Wire-level reasoning effort sent to providers (excludes "off"). */
export type ReasoningEffort = Exclude<ModelReasoningMode, "off">;

export const REASONING_MODE_LABELS: Record<ModelReasoningMode, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

/** Fallback when the catalog omits per-model reasoning metadata. */
export const DEFAULT_REASONING_MODES: ReadonlyArray<{ id: ModelReasoningMode; label: string }> = [
  { id: "off", label: REASONING_MODE_LABELS.off },
  { id: "low", label: REASONING_MODE_LABELS.low },
  { id: "medium", label: REASONING_MODE_LABELS.medium },
  { id: "high", label: REASONING_MODE_LABELS.high },
  { id: "max", label: REASONING_MODE_LABELS.max },
];

/** Full gateway effort list when the catalog accepts any value (`supported_efforts: null`). */
export const ALL_GATEWAY_REASONING_MODES: ReadonlyArray<{ id: ModelReasoningMode; label: string }> = [
  { id: "max", label: REASONING_MODE_LABELS.max },
  { id: "xhigh", label: REASONING_MODE_LABELS.xhigh },
  { id: "high", label: REASONING_MODE_LABELS.high },
  { id: "medium", label: REASONING_MODE_LABELS.medium },
  { id: "low", label: REASONING_MODE_LABELS.low },
  { id: "minimal", label: REASONING_MODE_LABELS.minimal },
  { id: "off", label: REASONING_MODE_LABELS.off },
];

/** @deprecated Use {@link DEFAULT_REASONING_MODES} or {@link getModelReasoningOptions}. */
export const MODEL_REASONING_MODES = DEFAULT_REASONING_MODES;

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

const REASONING_MODE_SET = new Set<string>(Object.keys(REASONING_MODE_LABELS));

/** Map catalog effort tokens (`none`, `max`, …) to stored modes. */
export function apiEffortToMode(effort: string): ModelReasoningMode | null {
  const normalized = effort.trim().toLowerCase();
  if (normalized === "none") return "off";
  return REASONING_MODE_SET.has(normalized) ? (normalized as ModelReasoningMode) : null;
}

export function isModelReasoningMode(value: unknown): value is ModelReasoningMode {
  return typeof value === "string" && REASONING_MODE_SET.has(value);
}

function modeOption(id: ModelReasoningMode): { id: ModelReasoningMode; label: string } {
  return { id, label: REASONING_MODE_LABELS[id] };
}

function modesFromApiEfforts(efforts: string[]): ModelReasoningMode[] {
  const seen = new Set<ModelReasoningMode>();
  const out: ModelReasoningMode[] = [];
  for (const effort of efforts) {
    const mode = apiEffortToMode(effort);
    if (!mode || seen.has(mode)) continue;
    seen.add(mode);
    out.push(mode);
  }
  return out;
}

/** Parse the `reasoning` block (or `supported_parameters`) from a catalog entry. */
export function parseModelReasoningMeta(raw: unknown): ModelReasoningMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;

  const reasoningRaw = rec.reasoning;
  if (reasoningRaw && typeof reasoningRaw === "object") {
    const r = reasoningRaw as Record<string, unknown>;
    const supported =
      r.supported_efforts === null
        ? null
        : Array.isArray(r.supported_efforts)
          ? r.supported_efforts.filter((v): v is string => typeof v === "string")
          : undefined;
    const defaultEffort = typeof r.default_effort === "string" ? r.default_effort : undefined;
    return {
      supportedEfforts: supported,
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(typeof r.default_enabled === "boolean" ? { defaultEnabled: r.default_enabled } : {}),
      ...(r.mandatory === true ? { mandatory: true } : {}),
      ...(r.supports_max_tokens === true ? { supportsMaxTokens: true } : {}),
    };
  }

  for (const key of ["supported_parameters", "supportedParameters"]) {
    const params = rec[key];
    if (!Array.isArray(params)) continue;
    if (params.some((p) => String(p).toLowerCase() === "reasoning_effort")) {
      return { supportedEfforts: null };
    }
  }

  return undefined;
}

/** Reasoning mode choices for the picker: catalog metadata first, default list as fallback. */
export function getModelReasoningOptions(
  model?: { reasoning?: ModelReasoningMeta },
): ReadonlyArray<{ id: ModelReasoningMode; label: string }> {
  const reasoning = model?.reasoning;
  if (!reasoning) return DEFAULT_REASONING_MODES;

  let modes: ModelReasoningMode[];
  if (reasoning.supportedEfforts === null) {
    modes = ALL_GATEWAY_REASONING_MODES.map((m) => m.id);
  } else if (reasoning.supportedEfforts && reasoning.supportedEfforts.length > 0) {
    modes = modesFromApiEfforts(reasoning.supportedEfforts);
    if (modes.length === 0) return DEFAULT_REASONING_MODES;
  } else {
    return DEFAULT_REASONING_MODES;
  }

  if (reasoning.mandatory) modes = modes.filter((m) => m !== "off");
  return modes.map(modeOption);
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
): { thinking: boolean; effort?: ReasoningEffort } {
  const mode = getModelReasoningMode(settings, providerId, modelId);
  if (mode === "off") return { thinking: false };
  if (mode) return { thinking: true, effort: mode };
  return { thinking: settings.thinking };
}

export function reasoningModeLabel(
  settings: Pick<DeyinSettings, "thinking" | "modelEfforts">,
  providerId: string,
  modelId: string,
): string {
  const mode = getModelReasoningMode(settings, providerId, modelId);
  if (mode) return REASONING_MODE_LABELS[mode];
  return settings.thinking ? "Auto" : "Off";
}
