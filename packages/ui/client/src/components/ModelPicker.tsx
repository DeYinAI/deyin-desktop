import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getModelReasoningMode,
  getModelReasoningOptions,
  modelIsVideo,
  reasoningModeLabel,
  type ModelReasoningMode,
} from "@deyin/host-core/shared";
import { useAnchoredMenuPosition } from "../hooks/useAnchoredMenuPosition.js";
import { Icon } from "./Icon.js";
import type { ModelInfo, ProviderInfo, ProviderModel } from "@deyin/contract";

interface ModelPickerProps {
  /** Live models for the primary (Openference) provider. */
  models: ModelInfo[];
  selected: string;
  onSelect: (id: string) => void;
  providers?: ProviderInfo[];
  selectedProviderId?: string;
  onSelectProviderModel?: (providerId: string, modelId: string) => void;
  onManageModels?: () => void;
  /** Per-model reasoning mode overrides ("providerId::modelId" -> off | low | medium | high). */
  modelEfforts?: Record<string, string>;
  /** Global thinking default when a model has no explicit mode. */
  thinkingDefault?: boolean;
  onSetModelEffort?: (providerId: string, modelId: string, mode: ModelReasoningMode | undefined) => void;
}

export function formatContext(n?: number): string | null {
  if (!n) return null;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Two-level picker: click a provider on the left, pick a model on the right. */
export function ModelPicker(props: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [modePanelOpen, setModePanelOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredMenuPosition(open, anchorRef, panelRef);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
        setModePanelOpen(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (modePanelOpen) setModePanelOpen(false);
        else {
          setOpen(false);
          setModePanelOpen(false);
        }
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open, modePanelOpen]);

  useEffect(() => {
    if (!open) {
      setModePanelOpen(false);
      return;
    }
    const fallback = props.selectedProviderId ?? props.providers?.find((p) => p.enabled)?.id ?? null;
    setActiveProviderId(fallback);
  }, [open, props.selectedProviderId, props.providers]);

  const providers = (props.providers ?? []).filter((p) => p.enabled);
  const sessionProviderId = props.selectedProviderId ?? providers[0]?.id;
  const shownProviderId = activeProviderId ?? sessionProviderId;
  const shownProvider = providers.find((p) => p.id === shownProviderId);

  const modelsOf = (provider: ProviderInfo | undefined): ProviderModel[] => {
    const primaryModels = () => props.models.map((m) => ({ id: m.id, name: m.name, contextLength: m.contextLength, kind: m.kind }));
    if (!provider) return primaryModels();
    const list = provider.kind === "primary" ? primaryModels() : provider.models;
    const disabled = new Set(provider.disabledModels);
    return list.filter((m) => !disabled.has(m.id));
  };

  const effortSettings = {
    modelEfforts: props.modelEfforts ?? {},
    thinking: props.thinkingDefault ?? true,
  };

  const currentLabel =
    props.models.find((m) => m.id === props.selected)?.name ??
    providers.flatMap((p) => p.models).find((m) => m.id === props.selected)?.name ??
    props.selected ??
    "Select model";

  const currentModeLabel =
    sessionProviderId && props.selected
      ? reasoningModeLabel(effortSettings, sessionProviderId, props.selected)
      : null;

  const pick = (providerId: string | undefined, modelId: string) => {
    if (providerId && props.onSelectProviderModel) props.onSelectProviderModel(providerId, modelId);
    else props.onSelect(modelId);
    setOpen(false);
    setModePanelOpen(false);
  };

  const setMode = (providerId: string, modelId: string, mode: ModelReasoningMode | undefined) => {
    props.onSetModelEffort?.(providerId, modelId, mode);
  };

  const shownModels = modelsOf(shownProvider);
  const showProviderRail = providers.length > 1;

  const selectedModelInfo =
    props.models.find((m) => m.id === props.selected) ??
    providers.flatMap((p) => p.models).find((m) => m.id === props.selected);
  const canEditReasoning =
    Boolean(props.onSetModelEffort) &&
    Boolean(sessionProviderId && props.selected) &&
    !modelIsVideo(props.selected, selectedModelInfo?.kind) &&
    selectedModelInfo?.kind !== "image";
  const sessionSavedMode =
    sessionProviderId && props.selected
      ? getModelReasoningMode(effortSettings, sessionProviderId, props.selected)
      : undefined;
  const sessionEffectiveMode =
    sessionSavedMode ?? (effortSettings.thinking ? ("auto" as const) : ("off" as const));
  const reasoningOptions = getModelReasoningOptions(selectedModelInfo);
  const showAutoOption = !selectedModelInfo?.reasoning?.mandatory;

  const toggleOpen = () => {
    setOpen((v) => !v);
  };

  const panel = open ? (
    <div
      ref={panelRef}
      className={`anchored-menu__panel modelmenu ${showProviderRail ? "" : "modelmenu--single"} ${modePanelOpen ? "modelmenu--mode-open" : ""}`}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
    >
      {showProviderRail && (
        <div className="modelmenu__providers">
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className={`menu__item modelmenu__provider ${provider.id === shownProviderId ? "menu__item--active" : ""}`}
              onClick={() => {
                setActiveProviderId(provider.id);
                setModePanelOpen(false);
              }}
            >
              <span
                className={`provider-row__status ${provider.status === "connected" ? "provider-row__status--on" : ""}`}
              />
              <span className="modelmenu__name">{provider.name}</span>
              {provider.id === sessionProviderId && <Icon name="check" size={12} />}
              <Icon name="chevronRight" size={11} />
            </button>
          ))}
          <div className="modelmenu__rule" />
          <button
            type="button"
            className="menu__item"
            onClick={() => {
              setOpen(false);
              props.onManageModels?.();
            }}
          >
            Manage models
          </button>
        </div>
      )}

      <div className="modelmenu__models">
        <div className="modelmenu__models-scroll">
          {showProviderRail && shownProvider && <div className="modelmenu__header">{shownProvider.name}</div>}
          {shownModels.map((model) => {
            const providerId = shownProvider?.id ?? sessionProviderId ?? "openference";
            const isSelected = model.id === props.selected && providerId === sessionProviderId;

            return (
              <button
                key={model.id}
                type="button"
                className={`modelmenu__pick ${isSelected ? "modelmenu__pick--active" : ""}`}
                title={model.name}
                onClick={() => pick(shownProvider?.id, model.id)}
              >
                <span className="modelmenu__name">{model.name}</span>
                <span className="modelmenu__meta">
                  {model.kind === "image" ? (
                    <span className="badge badge--muted" title="Text-to-image model">
                      Image
                    </span>
                  ) : modelIsVideo(model.id, model.kind) ? (
                    <span className="badge badge--muted" title="Text-to-video model">
                      Video
                    </span>
                  ) : (
                    <>
                      {model.imageOutput && (
                        <span className="badge badge--muted" title="Chat model that can draw pictures">
                          Draws
                        </span>
                      )}
                      {formatContext(model.contextLength) && (
                        <span className="badge badge--muted">{formatContext(model.contextLength)}</span>
                      )}
                    </>
                  )}
                  <span className="modelmenu__check-slot" aria-hidden={!isSelected}>
                    {isSelected && <Icon name="check" size={12} />}
                  </span>
                </span>
              </button>
            );
          })}
        {shownModels.length === 0 && (
          <div className="menu__item hint">
            {shownProvider && shownProvider.disabledModels.length > 0
              ? "All models are switched off - enable some under Manage models"
              : shownProvider?.kind === "custom"
                ? "No models added yet"
                : "No models available"}
          </div>
        )}
        {!showProviderRail && (
          <>
            <div className="modelmenu__rule" />
            <button
              type="button"
              className="menu__item"
              onClick={() => {
                setOpen(false);
                props.onManageModels?.();
              }}
            >
              Manage models
            </button>
          </>
        )}
        </div>

        {canEditReasoning && currentModeLabel && (
          <div className="modelmenu__footer">
            <span className="modelmenu__footer-label">Reasoning</span>
            <span className="modelmenu__footer-value">{currentModeLabel}</span>
            <button
              type="button"
              className="modelmenu__edit"
              aria-label="Edit reasoning mode"
              aria-expanded={modePanelOpen}
              onClick={() => setModePanelOpen((v) => !v)}
            >
              <Icon name="pencil" size={11} />
              Edit
            </button>
          </div>
        )}
      </div>

      {modePanelOpen && canEditReasoning && sessionProviderId && (
        <div className="modelmenu__mode-col">
          <div className="modelmenu__header">Reasoning mode</div>
          {showAutoOption && (
            <button
              type="button"
              className={`menu__item ${!sessionSavedMode ? "menu__item--active" : ""}`}
              onClick={() => setMode(sessionProviderId, props.selected, undefined)}
            >
              Auto
              {!sessionSavedMode && <Icon name="check" size={12} />}
            </button>
          )}
          {reasoningOptions.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`menu__item ${
                sessionSavedMode === mode.id ||
                (!sessionSavedMode && mode.id === "off" && sessionEffectiveMode === "off")
                  ? "menu__item--active"
                  : ""
              }`}
              onClick={() => setMode(sessionProviderId, props.selected, mode.id)}
            >
              {mode.label}
              {(sessionSavedMode === mode.id ||
                (!sessionSavedMode && mode.id === "off" && sessionEffectiveMode === "off")) && (
                <Icon name="check" size={12} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className="menu">
      <button
        ref={anchorRef}
        className="chip chip--model"
        onClick={toggleOpen}
        title={currentLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="chip__dot" />
        <span className="chip--model__label">
          {currentLabel}
          {currentModeLabel && currentModeLabel !== "Auto" && (
            <span className="chip--model__mode">{currentModeLabel}</span>
          )}
        </span>
        <Icon name="chevronDown" size={11} />
      </button>

      {panel && createPortal(panel, document.body)}
    </div>
  );
}
