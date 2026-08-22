import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  MODEL_REASONING_MODES,
  getModelReasoningMode,
  modelEffortKey,
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
  const [modeMenuKey, setModeMenuKey] = useState<string | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredMenuPosition(open, anchorRef, panelRef);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
        setModeMenuKey(null);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setModeMenuKey(null);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setModeMenuKey(null);
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
    setModeMenuKey(null);
  };

  const setMode = (providerId: string, modelId: string, mode: ModelReasoningMode) => {
    props.onSetModelEffort?.(providerId, modelId, mode);
    setModeMenuKey(null);
  };

  const shownModels = modelsOf(shownProvider);
  const showProviderRail = providers.length > 1;

  const toggleOpen = () => {
    setOpen((v) => !v);
  };

  const panel = open ? (
    <div
      ref={panelRef}
      className={`menu__panel menu__panel--anchored modelmenu ${showProviderRail ? "" : "modelmenu--single"}`}
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
                setModeMenuKey(null);
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
        {showProviderRail && shownProvider && <div className="modelmenu__header">{shownProvider.name}</div>}
        {shownModels.map((model) => {
          const providerId = shownProvider?.id ?? sessionProviderId ?? "openference";
          const key = modelEffortKey(providerId, model.id);
          const isSelected = model.id === props.selected && providerId === sessionProviderId;
          const savedMode = getModelReasoningMode(effortSettings, providerId, model.id);
          const effectiveMode = savedMode ?? (effortSettings.thinking ? ("auto" as const) : ("off" as const));
          const modeLabel = reasoningModeLabel(effortSettings, providerId, model.id);
          const showMode = model.kind !== "image" && props.onSetModelEffort && (isSelected || modeMenuKey === key);

          return (
            <div key={model.id} className={`modelmenu__row ${isSelected ? "modelmenu__row--active" : ""}`}>
              <button
                type="button"
                className="modelmenu__pick"
                title={model.name}
                onClick={() => pick(shownProvider?.id, model.id)}
              >
                <span className="modelmenu__name">{model.name}</span>
                {model.kind === "image" ? (
                  <span className="badge badge--muted" title="Text-to-image model">
                    Image
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
                {isSelected && <Icon name="check" size={12} />}
              </button>

              {showMode && (
                <div className="modelmenu__mode-wrap">
                  <button
                    type="button"
                    className={`modelmenu__mode ${modeMenuKey === key ? "modelmenu__mode--open" : ""}`}
                    title="Reasoning mode"
                    aria-label={`Reasoning mode: ${modeLabel}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setModeMenuKey((cur) => (cur === key ? null : key));
                    }}
                  >
                    <Icon name="sliders" size={11} />
                    <span>{modeLabel}</span>
                  </button>
                  {modeMenuKey === key && (
                    <div className="modelmenu__mode-panel">
                      <button
                        type="button"
                        className={`menu__item ${!savedMode ? "menu__item--active" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onSetModelEffort?.(providerId, model.id, undefined);
                          setModeMenuKey(null);
                        }}
                      >
                        Auto
                      </button>
                      {MODEL_REASONING_MODES.map((mode) => (
                        <button
                          key={mode.id}
                          type="button"
                          className={`menu__item ${
                            savedMode === mode.id || (!savedMode && mode.id === "off" && effectiveMode === "off")
                              ? "menu__item--active"
                              : ""
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setMode(providerId, model.id, mode.id);
                          }}
                        >
                          {mode.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
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
