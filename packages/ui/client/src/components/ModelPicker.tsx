import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
import { Toggle } from "./settings/controls.js";
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
  /** This task's thinking switch (falls back to `thinkingDefault`). */
  thinking?: boolean;
  onToggleThinking?: (enabled: boolean) => void;
}

export function formatContext(n?: number): string | null {
  if (!n) return null;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

interface PickRow {
  providerId: string | undefined;
  model: ProviderModel;
}

interface PickGroup {
  id: string;
  /** Provider name, shown as a heading only when more than one provider is enabled. */
  title: string | null;
  rows: PickRow[];
}

type View = "models" | "reasoning";

/** One-line detail beside a model name: its kind, or its context window. */
function modelDetail(model: ProviderModel): string | null {
  if (model.kind === "image") return "Image";
  if (modelIsVideo(model.id, model.kind)) return "Video";
  const context = formatContext(model.contextLength);
  return model.imageOutput ? (context ? `Draws · ${context}` : "Draws") : context;
}

/**
 * Compact model menu: search, an optional Reasoning row, models grouped by
 * provider (selected one carries a check), and a link to Manage models.
 */
export function ModelPicker(props: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("models");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pos = useAnchoredMenuPosition(open, anchorRef, panelRef, { align: "end" });

  const close = () => {
    setOpen(false);
    setView("models");
    setQuery("");
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
        setView("models");
        setQuery("");
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (view === "reasoning") setView("models");
      else {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, view]);

  useEffect(() => {
    if (open && view === "models") searchRef.current?.focus();
  }, [open, view]);

  const providers = useMemo(() => (props.providers ?? []).filter((p) => p.enabled), [props.providers]);
  const sessionProviderId = props.selectedProviderId ?? providers[0]?.id;

  const groups = useMemo<PickGroup[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = (model: ProviderModel) =>
      !needle || model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle);
    const primary = (): ProviderModel[] =>
      props.models.map((m) => ({ id: m.id, name: m.name, contextLength: m.contextLength, kind: m.kind }));
    if (providers.length === 0) {
      return [{ id: "all", title: null, rows: primary().filter(matches).map((model) => ({ providerId: undefined, model })) }];
    }
    return providers
      .map((provider) => {
        const list = provider.kind === "primary" ? primary() : provider.models;
        const disabled = new Set(provider.disabledModels);
        return {
          id: provider.id,
          title: providers.length > 1 ? provider.name : null,
          rows: list
            .filter((m) => !disabled.has(m.id) && matches(m))
            .map((model) => ({ providerId: provider.id, model })),
        };
      })
      .filter((group) => group.rows.length > 0);
  }, [providers, props.models, query]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  const selectedIndex = flat.findIndex(
    (row) => row.model.id === props.selected && (!row.providerId || row.providerId === sessionProviderId),
  );

  // Start on the current model; once searching, start on the best match.
  useEffect(() => {
    setCursor(query.trim() ? 0 : Math.max(0, selectedIndex));
  }, [query, open, selectedIndex]);

  const effortSettings = {
    modelEfforts: props.modelEfforts ?? {},
    thinking: props.thinkingDefault ?? true,
  };

  const selectedModelInfo =
    props.models.find((m) => m.id === props.selected) ??
    providers.flatMap((p) => p.models).find((m) => m.id === props.selected);
  const currentLabel = selectedModelInfo?.name ?? (props.selected || "Select model");

  const sessionThinking = props.thinking ?? props.thinkingDefault ?? true;
  const currentModeLabel =
    sessionProviderId && props.selected ? reasoningModeLabel(effortSettings, sessionProviderId, props.selected) : null;
  // What sits beside the model name: an explicit reasoning level, or that thinking is off.
  const triggerNote = !sessionThinking ? "Off" : currentModeLabel && currentModeLabel !== "Auto" ? currentModeLabel : null;

  const pick = (row: PickRow) => {
    if (row.providerId && props.onSelectProviderModel) props.onSelectProviderModel(row.providerId, row.model.id);
    else props.onSelect(row.model.id);
    close();
  };

  const nonReasoningKind = modelIsVideo(props.selected, selectedModelInfo?.kind) || selectedModelInfo?.kind === "image";
  const canEditReasoning =
    Boolean(props.onSetModelEffort) && Boolean(sessionProviderId && props.selected) && !nonReasoningKind;
  const savedMode =
    sessionProviderId && props.selected
      ? getModelReasoningMode(effortSettings, sessionProviderId, props.selected)
      : undefined;
  const effectiveMode = savedMode ?? (effortSettings.thinking ? ("auto" as const) : ("off" as const));
  const reasoningOptions = getModelReasoningOptions(selectedModelInfo);
  const showAutoOption = !selectedModelInfo?.reasoning?.mandatory;

  const setMode = (mode: ModelReasoningMode | undefined) => {
    if (sessionProviderId) props.onSetModelEffort?.(sessionProviderId, props.selected, mode);
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(flat.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = flat[cursor];
      if (row) pick(row);
    }
  };

  const manage = () => {
    close();
    props.onManageModels?.();
  };

  let rowIndex = -1;
  const panel = open ? (
    <div
      ref={panelRef}
      className="anchored-menu__panel modelmenu"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
    >
      {view === "reasoning" ? (
        <div className="modelmenu__list" role="menu" aria-label="Reasoning">
          <button type="button" className="modelmenu__back" onClick={() => setView("models")}>
            <Icon name="chevronLeft" size={12} />
            Reasoning
          </button>
          {showAutoOption && (
            <button type="button" role="menuitemradio" aria-checked={!savedMode} className="modelmenu__pick" onClick={() => setMode(undefined)}>
              <span className="modelmenu__name">Auto</span>
              <span className="modelmenu__check-slot">{!savedMode && <Icon name="check" size={13} />}</span>
            </button>
          )}
          {reasoningOptions.map((mode) => {
            const active = savedMode === mode.id || (!savedMode && mode.id === "off" && effectiveMode === "off");
            return (
              <button
                key={mode.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className="modelmenu__pick"
                onClick={() => setMode(mode.id)}
              >
                <span className="modelmenu__name">{mode.label}</span>
                <span className="modelmenu__check-slot">{active && <Icon name="check" size={13} />}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <label className="modelmenu__search">
            <Icon name="search" size={13} />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search models"
              aria-label="Search models"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
            />
          </label>

          {(canEditReasoning || (props.onToggleThinking && !nonReasoningKind)) && (
            <div className="modelmenu__settings">
              {canEditReasoning && (
                <button type="button" className="modelmenu__setting" onClick={() => setView("reasoning")}>
                  <span className="modelmenu__setting-label">Reasoning</span>
                  <span className="modelmenu__setting-value">{currentModeLabel ?? "Auto"}</span>
                  <Icon name="chevronRight" size={12} />
                </button>
              )}
              {props.onToggleThinking && !nonReasoningKind && (
                <div className="modelmenu__setting modelmenu__setting--static">
                  <span className="modelmenu__setting-label">Thinking</span>
                  <Toggle checked={sessionThinking} label="Thinking" onChange={(v) => props.onToggleThinking?.(v)} />
                </div>
              )}
            </div>
          )}

          <div className="modelmenu__list" role="listbox" aria-label="Models">
            {groups.map((group) => (
              <div key={group.id} className="modelmenu__group">
                {group.title && <div className="modelmenu__header">{group.title}</div>}
                {group.rows.map((row) => {
                  rowIndex += 1;
                  const index = rowIndex;
                  const providerId = row.providerId ?? sessionProviderId;
                  const selected = row.model.id === props.selected && (!row.providerId || providerId === sessionProviderId);
                  const detail = modelDetail(row.model);
                  return (
                    <button
                      key={`${row.providerId ?? "primary"}:${row.model.id}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`modelmenu__pick${index === cursor ? " modelmenu__pick--cursor" : ""}`}
                      title={row.model.name}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => pick(row)}
                    >
                      <span className="modelmenu__name">{row.model.name}</span>
                      {detail && <span className="modelmenu__detail">{detail}</span>}
                      <span className="modelmenu__check-slot" aria-hidden={!selected}>
                        {selected && <Icon name="check" size={13} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            {flat.length === 0 && (
              <div className="modelmenu__empty">
                {query.trim() ? "No models match" : "No models available. Add a provider in Manage models."}
              </div>
            )}
          </div>

          {props.onManageModels && (
            <div className="modelmenu__footer">
              <button type="button" className="modelmenu__manage" onClick={manage}>
                <Icon name="sliders" size={13} />
                Manage models
              </button>
            </div>
          )}
        </>
      )}
    </div>
  ) : null;

  return (
    <div className="menu">
      <button
        ref={anchorRef}
        type="button"
        className="model-trigger"
        onClick={() => (open ? close() : setOpen(true))}
        title={currentLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="model-trigger__label">{currentLabel}</span>
        {triggerNote && <span className="model-trigger__note">{triggerNote}</span>}
        <Icon name="chevronDown" size={11} className="model-trigger__chevron" />
      </button>

      {panel && createPortal(panel, document.body)}
    </div>
  );
}
