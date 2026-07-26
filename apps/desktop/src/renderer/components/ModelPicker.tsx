import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import type { ModelInfo, ProviderInfo, ProviderModel } from "../../shared/types.js";

interface ModelPickerProps {
  /** Live models for the primary (Openference) provider. */
  models: ModelInfo[];
  selected: string;
  onSelect: (id: string) => void;
  providers?: ProviderInfo[];
  selectedProviderId?: string;
  onSelectProviderModel?: (providerId: string, modelId: string) => void;
  onManageModels?: () => void;
}

export function formatContext(n?: number): string | null {
  if (!n) return null;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Two-level picker: providers on the right, the hovered provider's models on the left. */
export function ModelPicker(props: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [hoverProviderId, setHoverProviderId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const providers = (props.providers ?? []).filter((p) => p.enabled);
  const activeProviderId = props.selectedProviderId ?? providers[0]?.id;
  const shownProviderId = hoverProviderId ?? activeProviderId;
  const shownProvider = providers.find((p) => p.id === shownProviderId);

  const modelsOf = (provider: ProviderInfo | undefined): ProviderModel[] => {
    if (!provider) return props.models.map((m) => ({ id: m.id, name: m.name, contextLength: m.contextLength }));
    if (provider.kind === "primary") {
      return props.models.map((m) => ({ id: m.id, name: m.name, contextLength: m.contextLength }));
    }
    return provider.models;
  };

  const currentLabel =
    props.models.find((m) => m.id === props.selected)?.name ??
    providers.flatMap((p) => p.models).find((m) => m.id === props.selected)?.name ??
    props.selected ??
    "Select model";

  const pick = (providerId: string | undefined, modelId: string) => {
    if (providerId && props.onSelectProviderModel) props.onSelectProviderModel(providerId, modelId);
    else props.onSelect(modelId);
    setOpen(false);
  };

  const shownModels = modelsOf(shownProvider);

  return (
    <div className="menu" ref={rootRef}>
      <button className="chip" onClick={() => setOpen((v) => !v)}>
        <span className="chip__dot" />
        <span>{currentLabel}</span>
        <Icon name="chevronDown" size={11} />
      </button>

      {open && (
        <div className="menu__panel menu__panel--up modelmenu">
          <div className="modelmenu__models">
            {shownModels.map((model) => (
              <button
                key={model.id}
                className={`menu__item ${model.id === props.selected ? "menu__item--active" : ""}`}
                onClick={() => pick(shownProvider?.id, model.id)}
              >
                <span className="modelmenu__name">{model.name}</span>
                {formatContext(model.contextLength) && (
                  <span className="badge badge--muted">{formatContext(model.contextLength)}</span>
                )}
                {model.id === props.selected && <Icon name="check" size={12} />}
              </button>
            ))}
            {shownModels.length === 0 && (
              <div className="menu__item hint">
                {shownProvider?.kind === "custom" ? "No models added yet" : "No models available"}
              </div>
            )}
          </div>

          {providers.length > 0 && (
            <div className="modelmenu__providers">
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  className={`menu__item ${provider.id === shownProviderId ? "menu__item--hover" : ""}`}
                  onMouseEnter={() => setHoverProviderId(provider.id)}
                  onClick={() => setHoverProviderId(provider.id)}
                >
                  <span
                    className={`provider-row__status ${provider.status === "connected" ? "provider-row__status--on" : ""}`}
                  />
                  <span className="modelmenu__name">{provider.name}</span>
                  {provider.id === activeProviderId && <Icon name="check" size={12} />}
                  <Icon name="chevronRight" size={11} />
                </button>
              ))}
              <div className="modelmenu__rule" />
              <button
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
        </div>
      )}
    </div>
  );
}
