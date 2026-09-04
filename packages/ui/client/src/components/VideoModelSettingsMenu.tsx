import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  VIDEO_ASPECT_PRESETS,
  VIDEO_SECONDS_PRESETS,
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

function modeLabel(mode: string | undefined): string {
  switch (mode) {
    case "reference":
      return "reference";
    case "keyframe":
      return "keyframe";
    default:
      return "text";
  }
}

function summaryLabel(params: VideoModelParams): string {
  const parts = [
    params.aspectRatio ?? "16:9",
    `${params.seconds ?? 5}s`,
    modeLabel(params.mode),
  ];
  if (params.seed != null) parts.push(`seed ${params.seed}`);
  return parts.join(" · ");
}

/** Composer bar/chip: tune Agnes Video params for the selected text-to-video model. */
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

  const commit = () => {
    const seedTrim = seedText.trim();
    const seed = seedTrim === "" ? undefined : Math.floor(Number(seedTrim));
    onChange(providerId, modelId, {
      aspectRatio: draft.aspectRatio,
      seconds: draft.seconds,
      size: draft.size,
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
      <div className="image-settings__header">Video settings</div>
      <p className="image-settings__hint">
        Agnes Video API: duration 4–12s, 720P on Flash, attach images in the composer for reference or keyframe
        modes.
      </p>
      <label className="image-settings__field">
        <span>Mode</span>
        <select
          className="select"
          value={draft.mode ?? "text"}
          onChange={(e) =>
            setDraft((d: VideoModelParams) => ({
              ...d,
              mode: e.target.value as VideoModelParams["mode"],
            }))
          }
        >
          <option value="text">Text-to-video</option>
          <option value="reference">Reference (image/audio)</option>
          <option value="keyframe">Keyframe (first/last frame)</option>
        </select>
      </label>
      <label className="image-settings__field">
        <span>Aspect ratio</span>
        <select
          className="select"
          value={draft.aspectRatio ?? "16:9"}
          onChange={(e) => setDraft((d: VideoModelParams) => ({ ...d, aspectRatio: e.target.value }))}
        >
          {VIDEO_ASPECT_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label} ({preset.pixels})
            </option>
          ))}
        </select>
      </label>
      <label className="image-settings__field">
        <span>Duration</span>
        <select
          className="select"
          value={draft.seconds ?? 5}
          onChange={(e) => setDraft((d: VideoModelParams) => ({ ...d, seconds: Number(e.target.value) }))}
        >
          {VIDEO_SECONDS_PRESETS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds} seconds
            </option>
          ))}
        </select>
      </label>
      {draft.size ? (
        <label className="image-settings__field">
          <span>Resolution</span>
          <input className="select" value={draft.size} readOnly aria-readonly />
        </label>
      ) : null}
      <label className="image-settings__field">
        <span>Seed (optional)</span>
        <input type="number" placeholder="Random" value={seedText} onChange={(e) => setSeedText(e.target.value)} />
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
