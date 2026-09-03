import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  VIDEO_ASPECT_PRESETS,
  VIDEO_FRAME_PRESETS,
  resolveVideoModelParams,
  videoModelParamsKey,
  type VideoModelParams,
} from "@deyin/host-core/shared";
import { useAnchoredMenuPosition } from "../hooks/useAnchoredMenuPosition.js";
import { Icon } from "./Icon.js";

interface VideoModelSettingsMenuProps {
  providerId: string;
  modelId: string;
  saved?: VideoModelParams;
  onChange: (providerId: string, modelId: string, params: VideoModelParams) => void;
  variant?: "chip" | "bar";
}

function summaryLabel(params: VideoModelParams): string {
  const parts = [
    params.aspectRatio ?? "16:9",
    `${params.numFrames ?? 121}f`,
    `${params.frameRate ?? 24}fps`,
  ];
  if (params.seed != null) parts.push(`seed ${params.seed}`);
  return parts.join(" · ");
}

/** Composer chip: tune Agnes-style video params for the selected text-to-video model. */
export function VideoModelSettingsMenu({
  providerId,
  modelId,
  saved,
  onChange,
  variant = "chip",
}: VideoModelSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredMenuPosition(open, anchorRef, panelRef);

  const resolved = resolveVideoModelParams(modelId, saved);
  const [draft, setDraft] = useState(resolved);
  const [seedText, setSeedText] = useState(saved?.seed != null ? String(saved.seed) : "");

  useEffect(() => {
    if (!open) {
      const next = resolveVideoModelParams(modelId, saved);
      setDraft(next);
      setSeedText(saved?.seed != null ? String(saved.seed) : "");
    }
  }, [open, modelId, saved]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const applyAspect = (aspectRatio: string) => {
    const preset = VIDEO_ASPECT_PRESETS.find((p) => p.id === aspectRatio);
    setDraft((d: VideoModelParams) => ({
      ...d,
      aspectRatio,
      ...(preset ? { width: preset.width, height: preset.height } : {}),
    }));
  };

  const commit = () => {
    const seedTrim = seedText.trim();
    const seed = seedTrim === "" ? undefined : Math.floor(Number(seedTrim));
    onChange(providerId, modelId, {
      aspectRatio: draft.aspectRatio,
      width: draft.width,
      height: draft.height,
      numFrames: draft.numFrames,
      frameRate: draft.frameRate,
      numInferenceSteps: draft.numInferenceSteps,
      negativePrompt: draft.negativePrompt,
      mode: draft.mode,
      ...(seed != null && Number.isFinite(seed) ? { seed } : {}),
    });
    setOpen(false);
  };

  const resetDefaults = () => {
    setDraft(resolveVideoModelParams(modelId, null));
    setSeedText("");
    onChange(providerId, modelId, {});
  };

  const panel = open ? (
    <div
      ref={panelRef}
      className="anchored-menu__panel image-settings video-settings"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
    >
      <div className="image-settings__header">Agnes video settings</div>
      <label className="image-settings__field">
        <span>Aspect ratio</span>
        <select
          className="select"
          value={draft.aspectRatio ?? "16:9"}
          onChange={(e) => applyAspect(e.target.value)}
        >
          {VIDEO_ASPECT_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label} ({preset.width}×{preset.height})
            </option>
          ))}
        </select>
      </label>
      <label className="image-settings__field">
        <span>Duration (frames)</span>
        <select
          className="select"
          value={draft.numFrames ?? 121}
          onChange={(e) => setDraft((d: VideoModelParams) => ({ ...d, numFrames: Number(e.target.value) }))}
        >
          {VIDEO_FRAME_PRESETS.map((preset) => (
            <option key={preset.frames} value={preset.frames}>
              {preset.frames} frames — {preset.label}
            </option>
          ))}
        </select>
      </label>
      <label className="image-settings__field">
        <span>Frame rate ({draft.frameRate ?? 24} fps)</span>
        <input
          type="range"
          min={1}
          max={60}
          step={1}
          value={draft.frameRate ?? 24}
          onChange={(e) => setDraft((d: VideoModelParams) => ({ ...d, frameRate: Number(e.target.value) }))}
        />
      </label>
      <label className="image-settings__field">
        <span>Inference steps ({draft.numInferenceSteps ?? 20})</span>
        <input
          type="range"
          min={1}
          max={50}
          step={1}
          value={draft.numInferenceSteps ?? 20}
          onChange={(e) =>
            setDraft((d: VideoModelParams) => ({ ...d, numInferenceSteps: Number(e.target.value) }))
          }
        />
      </label>
      <label className="image-settings__field">
        <span>Seed (optional)</span>
        <input type="number" placeholder="Random" value={seedText} onChange={(e) => setSeedText(e.target.value)} />
      </label>
      <label className="image-settings__field">
        <span>Mode (optional)</span>
        <select
          className="select"
          value={draft.mode ?? ""}
          onChange={(e) =>
            setDraft((d: VideoModelParams) => ({
              ...d,
              mode: e.target.value.trim() ? e.target.value : undefined,
            }))
          }
        >
          <option value="">Default (text-to-video)</option>
          <option value="ti2vid">Image-to-video (ti2vid)</option>
          <option value="keyframes">Keyframe animation</option>
        </select>
      </label>
      <label className="image-settings__field image-settings__field--area">
        <span>Negative prompt</span>
        <textarea
          rows={3}
          value={draft.negativePrompt ?? ""}
          onChange={(e) => setDraft((d: VideoModelParams) => ({ ...d, negativePrompt: e.target.value }))}
        />
      </label>
      <div className="image-settings__actions">
        <button type="button" className="menu__item" onClick={resetDefaults}>
          Reset defaults
        </button>
        <button type="button" className="menu__item menu__item--active" onClick={commit}>
          Apply
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div className={`menu ${variant === "bar" ? "menu--image-settings-bar" : ""}`}>
      <button
        ref={anchorRef}
        type="button"
        className={`chip chip--on ${variant === "bar" ? "chip--image-settings-bar" : ""}`}
        title={`Video settings for ${modelId}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {variant === "chip" ? <Icon name="sliders" size={12} /> : null}
        <span>{summaryLabel(resolved)}</span>
        <Icon name="chevronDown" size={11} />
      </button>
      {panel && createPortal(panel, document.body)}
    </div>
  );
}

export { videoModelParamsKey };
