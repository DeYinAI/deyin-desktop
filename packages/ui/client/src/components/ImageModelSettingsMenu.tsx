import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  IMAGE_SIZE_PRESETS,
  imageModelParamsKey,
  resolveImageModelParams,
  type ImageModelParams,
} from "@deyin/host-core/shared";
import { useAnchoredMenuPosition } from "../hooks/useAnchoredMenuPosition.js";
import { Icon } from "./Icon.js";

interface ImageModelSettingsMenuProps {
  providerId: string;
  modelId: string;
  saved?: ImageModelParams;
  onChange: (providerId: string, modelId: string, params: ImageModelParams) => void;
}

function summaryLabel(params: ImageModelParams): string {
  const parts = [`${params.numSteps ?? "?"} steps`, `g${params.guidance ?? "?"}`, params.size ?? "1024x1024"];
  if (params.seed != null) parts.push(`seed ${params.seed}`);
  return parts.join(" · ");
}

/** Composer chip: tune diffusion params for the selected text-to-image model. */
export function ImageModelSettingsMenu({ providerId, modelId, saved, onChange }: ImageModelSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredMenuPosition(open, anchorRef, panelRef);

  const resolved = resolveImageModelParams(modelId, saved);
  const [draft, setDraft] = useState(resolved);
  const [seedText, setSeedText] = useState(saved?.seed != null ? String(saved.seed) : "");

  useEffect(() => {
    if (!open) {
      const next = resolveImageModelParams(modelId, saved);
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
      size: draft.size,
      numSteps: draft.numSteps,
      guidance: draft.guidance,
      negativePrompt: draft.negativePrompt,
      ...(seed != null && Number.isFinite(seed) ? { seed } : {}),
    });
    setOpen(false);
  };

  const resetDefaults = () => {
    setDraft(resolveImageModelParams(modelId, null));
    setSeedText("");
    onChange(providerId, modelId, {});
  };

  const panel = open ? (
    <div
      ref={panelRef}
      className="anchored-menu__panel image-settings"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
    >
      <div className="image-settings__header">Image quality</div>
      <label className="image-settings__field">
        <span>Size</span>
        <select
          className="select"
          value={draft.size ?? "1024x1024"}
          onChange={(e) => setDraft((d: ImageModelParams) => ({ ...d, size: e.target.value }))}
        >
          {IMAGE_SIZE_PRESETS.map((size: (typeof IMAGE_SIZE_PRESETS)[number]) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <label className="image-settings__field">
        <span>Steps ({draft.numSteps ?? 20})</span>
        <input
          type="range"
          min={1}
          max={20}
          step={1}
          value={draft.numSteps ?? 20}
          onChange={(e) => setDraft((d: ImageModelParams) => ({ ...d, numSteps: Number(e.target.value) }))}
        />
      </label>
      <label className="image-settings__field">
        <span>Guidance ({draft.guidance ?? 7.5})</span>
        <input
          type="range"
          min={5}
          max={12}
          step={0.5}
          value={draft.guidance ?? 7.5}
          onChange={(e) => setDraft((d: ImageModelParams) => ({ ...d, guidance: Number(e.target.value) }))}
        />
      </label>
      <label className="image-settings__field">
        <span>Seed (optional)</span>
        <input
          type="number"
          placeholder="Random"
          value={seedText}
          onChange={(e) => setSeedText(e.target.value)}
        />
      </label>
      <label className="image-settings__field image-settings__field--area">
        <span>Negative prompt</span>
        <textarea
          rows={3}
          value={draft.negativePrompt ?? ""}
          onChange={(e) => setDraft((d: ImageModelParams) => ({ ...d, negativePrompt: e.target.value }))}
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
    <div className="menu">
      <button
        ref={anchorRef}
        type="button"
        className="chip chip--on"
        title={`Image settings for ${modelId}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="sliders" size={12} />
        <span>{summaryLabel(resolved)}</span>
        <Icon name="chevronDown" size={11} />
      </button>
      {panel && createPortal(panel, document.body)}
    </div>
  );
}

export { imageModelParamsKey };
