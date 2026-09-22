import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BotWorkflowDefinition,
  ExternalAgentDescriptor,
  WorkflowStageDefinition,
} from "@deyin/contract";
import { Icon } from "./Icon.js";
import { Callout } from "./ui/index.js";
import { Field, FormSection, SettingCard, Toggle } from "./settings/controls.js";

export interface BotWorkflowsViewProps {
  workspaceRoot?: string | null;
  initialWorkflowId?: string | null;
  onBack: () => void;
  onRunWorkflow?: (workflowId: string) => void;
}

function emptyWorkflow(agentId = "codex"): BotWorkflowDefinition {
  return {
    id: "",
    name: "New Pipeline",
    description: "Multi-agent staged coding workflow",
    stages: [
      {
        id: "stage-1",
        name: "Architecture & Design",
        agentId,
        userPromptTemplate: "Analyze requirements and design architecture for:\n{{inputs.goal}}",
        worktree: { isolate: true },
        watchdog: { timeoutMs: 900_000, stallThresholdMs: 120_000, onStallAction: "alert-user" },
      },
      {
        id: "stage-2",
        name: "Implementation",
        agentId: "claude",
        userPromptTemplate: "Implement feature based on architecture:\n{{stage.stage-1.output}}",
        worktree: { isolate: true },
        watchdog: { timeoutMs: 1_200_000, stallThresholdMs: 180_000, onStallAction: "alert-user" },
      },
    ],
    schedule: {
      enabled: false,
      cronExpression: "0 * * * *",
      intervalMinutes: 60,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function BotWorkflowsView({
  workspaceRoot,
  initialWorkflowId,
  onBack,
  onRunWorkflow,
}: BotWorkflowsViewProps) {
  const [workflows, setWorkflows] = useState<BotWorkflowDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialWorkflowId ?? null);
  const [draft, setDraft] = useState<BotWorkflowDefinition>(() => emptyWorkflow());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [availableAgents, setAvailableAgents] = useState<ExternalAgentDescriptor[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Load external agents
  useEffect(() => {
    if (window.deyin?.externalAgents) {
      window.deyin.externalAgents
        .list()
        .then((list) => setAvailableAgents(list))
        .catch(() => {});
    }
  }, []);

  // Load workflows list
  const loadWorkflows = useCallback(
    async (targetIdToSelect?: string | null) => {
      if (!window.deyin?.botWorkflows) return;
      try {
        const list = await window.deyin.botWorkflows.list();
        setWorkflows(list);

        const targetId = targetIdToSelect !== undefined ? targetIdToSelect : selectedId;
        if (targetId) {
          const found = list.find((w) => w.id === targetId);
          if (found) {
            setSelectedId(found.id);
            setDraft(JSON.parse(JSON.stringify(found)));
            setDirty(false);
            return;
          }
        }

        if (list.length > 0 && targetId === undefined) {
          setSelectedId(list[0]!.id);
          setDraft(JSON.parse(JSON.stringify(list[0]!)));
          setDirty(false);
        } else if (list.length === 0) {
          setSelectedId(null);
          setDraft(emptyWorkflow());
          setDirty(false);
        }
      } catch (err: any) {
        setErrorMessage(err.message || "Failed to load workflows");
      }
    },
    [selectedId],
  );

  useEffect(() => {
    loadWorkflows(initialWorkflowId);
  }, [initialWorkflowId, loadWorkflows]);

  const selectWorkflow = (wf: BotWorkflowDefinition) => {
    setSelectedId(wf.id);
    setDraft(JSON.parse(JSON.stringify(wf)));
    setDirty(false);
    setSavedAt(null);
    setErrorMessage(null);
  };

  const startNew = () => {
    const defaultAgent = availableAgents.find((a) => a.installed)?.id ?? "codex";
    setSelectedId(null);
    setDraft(emptyWorkflow(defaultAgent));
    setDirty(true);
    setSavedAt(null);
    setErrorMessage(null);
  };

  const updateDraft = (patch: Partial<BotWorkflowDefinition>) => {
    setDirty(true);
    setSavedAt(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const addStage = () => {
    const nextNum = draft.stages.length + 1;
    const defaultAgent = availableAgents.find((a) => a.installed)?.id ?? "codex";
    const prevStage = draft.stages[draft.stages.length - 1];
    const newStageId = `stage-${nextNum}-${Date.now().toString(36).slice(-4)}`;

    const newStage: WorkflowStageDefinition = {
      id: newStageId,
      name: `Stage ${nextNum}`,
      agentId: defaultAgent,
      userPromptTemplate: prevStage
        ? `Task based on prior stage output:\n{{stage.${prevStage.id}.output}}`
        : "Instructions for this stage...",
      worktree: { isolate: true },
      watchdog: { timeoutMs: 900_000, stallThresholdMs: 120_000, onStallAction: "alert-user" },
    };

    updateDraft({ stages: [...draft.stages, newStage] });
  };

  const removeStage = (index: number) => {
    if (draft.stages.length <= 1) return;
    const next = draft.stages.filter((_, i) => i !== index);
    updateDraft({ stages: next });
  };

  const moveStage = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= draft.stages.length) return;
    const next = [...draft.stages];
    const item = next[index]!;
    next[index] = next[targetIndex]!;
    next[targetIndex] = item;
    updateDraft({ stages: next });
  };

  const updateStage = (index: number, patch: Partial<WorkflowStageDefinition>) => {
    const next = [...draft.stages];
    next[index] = { ...next[index]!, ...patch };
    updateDraft({ stages: next });
  };

  const insertVariable = (index: number, token: string) => {
    const stage = draft.stages[index];
    if (!stage) return;
    updateStage(index, { userPromptTemplate: `${stage.userPromptTemplate} ${token}` });
  };

  const handleSave = async () => {
    if (!draft.name.trim()) {
      setErrorMessage("Workflow name cannot be empty");
      return;
    }
    if (!window.deyin?.botWorkflows) return;

    setSaving(true);
    setErrorMessage(null);
    try {
      const payload: BotWorkflowDefinition = {
        ...draft,
        name: draft.name.trim(),
        description: draft.description?.trim(),
        createdAt: draft.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      const saved = await window.deyin.botWorkflows.save(payload);
      const nextId = saved?.id || payload.id;
      if (nextId) {
        setSelectedId(nextId);
        setDraft(saved ?? payload);
      }
      setDirty(false);
      setSavedAt(Date.now());
      await loadWorkflows(nextId);
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to save workflow");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId || !window.deyin?.botWorkflows) return;
    if (!window.confirm(`Delete workflow "${draft.name}"?`)) return;

    try {
      await window.deyin.botWorkflows.delete(selectedId);
      await loadWorkflows(null);
      startNew();
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to delete workflow");
    }
  };

  const handleDuplicate = () => {
    const clone: BotWorkflowDefinition = {
      ...draft,
      id: "",
      name: `${draft.name} (Copy)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setSelectedId(null);
    setDraft(clone);
    setDirty(true);
    setSavedAt(null);
  };

  const handleRunNow = async () => {
    if (!selectedId) {
      // If unsaved, save first then run
      await handleSave();
    }
    const targetId = selectedId || draft.id;
    if (targetId && onRunWorkflow) {
      onRunWorkflow(targetId);
    } else if (targetId && window.deyin?.botWorkflows) {
      try {
        await window.deyin.botWorkflows.run(targetId, workspaceRoot ?? "");
        onBack();
      } catch (err: any) {
        setErrorMessage(err.message || "Failed to start workflow");
      }
    }
  };

  const filteredWorkflows = useMemo(() => {
    if (!searchQuery.trim()) return workflows;
    const q = searchQuery.toLowerCase();
    return workflows.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        w.description?.toLowerCase().includes(q) ||
        w.stages.some((s) => s.name.toLowerCase().includes(q) || s.agentId.toLowerCase().includes(q)),
    );
  }, [workflows, searchQuery]);

  return (
    <div className="bot-workflows">
      {/* Left Master List */}
      <aside className="bot-workflows__list">
        <div className="bot-workflows__list-head">
          <div className="bot-workflows__list-title-wrap">
            <Icon name="bolt" size={15} />
            <span className="bot-workflows__list-title">Bot Workflows</span>
          </div>
          <button
            type="button"
            className="icon-btn icon-btn--small"
            title="Create new workflow"
            onClick={startNew}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>

        <div className="bot-workflows__search">
          <div className="search-row">
            <Icon name="search" size={13} className="search-row__icon" />
            <input
              type="text"
              className="search-row__input"
              placeholder="Filter workflows…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="icon-btn icon-btn--xs"
                onClick={() => setSearchQuery("")}
              >
                <Icon name="close" size={11} />
              </button>
            )}
          </div>
        </div>

        <div className="bot-workflows__items">
          {filteredWorkflows.map((item) => {
            const isSelected = selectedId === item.id;
            const agentsList = Array.from(new Set(item.stages.map((s) => s.agentId))).join(" → ");

            return (
              <button
                key={item.id}
                type="button"
                className={`bot-workflows__item${isSelected ? " bot-workflows__item--active" : ""}`}
                onClick={() => selectWorkflow(item)}
              >
                <div className="bot-workflows__item-top">
                  <span
                    className={`bot-workflows__dot${
                      item.schedule?.enabled ? " bot-workflows__dot--on" : ""
                    }`}
                  />
                  <span className="bot-workflows__item-title">{item.name}</span>
                </div>

                <div className="bot-workflows__item-meta">
                  {item.description || `${item.stages.length} stages (${agentsList})`}
                </div>

                <div className="bot-workflows__item-foot">
                  <span className="bot-workflows__item-pill">
                    <Icon name="bolt" size={11} />
                    <span>
                      {item.stages.length} {item.stages.length === 1 ? "stage" : "stages"}
                    </span>
                  </span>
                  {item.schedule?.enabled && (
                    <span className="bot-workflows__item-pill bot-workflows__item-pill--schedule">
                      <Icon name="clock" size={11} />
                      <span>{item.schedule.cronExpression || `${item.schedule.intervalMinutes}m`}</span>
                    </span>
                  )}
                </div>
              </button>
            );
          })}

          {filteredWorkflows.length === 0 && (
            <div className="bot-workflows__empty-list">
              <Icon name="bolt" size={24} className="text-muted" />
              <span>
                {workflows.length === 0 ? "No workflows configured yet." : "No matching workflows."}
              </span>
              {workflows.length === 0 && (
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  style={{ marginTop: 8 }}
                  onClick={startNew}
                >
                  <Icon name="plus" size={12} />
                  <span>Create Pipeline</span>
                </button>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* Right Detail / Editor Pane */}
      <section className="bot-workflows__editor">
        <header className="bot-workflows__head">
          <button
            type="button"
            className="icon-btn icon-btn--small"
            title="Back to workspace / bot mode"
            onClick={onBack}
          >
            <Icon name="arrowLeft" size={14} />
          </button>

          <div className="bot-workflows__head-text">
            <h1 className="bot-workflows__head-title">{draft.name || "Untitled Workflow"}</h1>
            <div className="bot-workflows__head-meta">
              {draft.stages.length} {draft.stages.length === 1 ? "stage" : "stages"} ·{" "}
              {draft.schedule?.enabled
                ? `Routine: ${draft.schedule.cronExpression || `${draft.schedule.intervalMinutes}m interval`}`
                : "Manual trigger"}
            </div>
          </div>

          <div className="bot-workflows__head-actions">
            <span className="bot-workflows__state">
              {dirty ? "Unsaved changes" : savedAt ? "Saved just now" : ""}
            </span>

            <button
              type="button"
              className="btn btn--primary"
              disabled={saving || !dirty}
              onClick={handleSave}
            >
              {saving ? "Saving…" : "Save"}
            </button>

            <button
              type="button"
              className="btn btn--ghost"
              onClick={handleRunNow}
              title="Execute this multi-bot pipeline"
            >
              <Icon name="bolt" size={13} />
              <span>Execute Pipeline</span>
            </button>

            <button
              type="button"
              className="icon-btn icon-btn--small"
              onClick={handleDuplicate}
              title="Duplicate workflow"
            >
              <Icon name="copy" size={14} />
            </button>

            {selectedId && (
              <button
                type="button"
                className="icon-btn icon-btn--small icon-btn--danger"
                onClick={handleDelete}
                title="Delete workflow"
              >
                <Icon name="trash" size={14} />
              </button>
            )}
          </div>
        </header>

        <div className="bot-workflows__body">
          {errorMessage && (
            <Callout tone="bad" className="bot-workflows__error-banner">
              {errorMessage}
            </Callout>
          )}

          {/* General Information FormSection */}
          <FormSection title="General Information" note="Identity & description">
            <Field
              label="Pipeline Name"
              hint="Descriptive name identifying this multi-agent workflow"
            >
              <input
                type="text"
                className="input"
                placeholder="e.g. Full-Stack Feature Flow (Codex + Claude + OpenCode)"
                value={draft.name}
                onChange={(e) => updateDraft({ name: e.target.value })}
              />
            </Field>

            <Field
              label="Description"
              hint="Optional summary of pipeline hand-offs or purpose"
            >
              <input
                type="text"
                className="input"
                placeholder="e.g. Architecture design in Codex → Implementation in Claude → Review in OpenCode"
                value={draft.description ?? ""}
                onChange={(e) => updateDraft({ description: e.target.value })}
              />
            </Field>
          </FormSection>

          {/* Visual Stages Flow Summary */}
          <FormSection
            title="Visual Pipeline Flow"
            note={`${draft.stages.length} connected ${draft.stages.length === 1 ? "stage" : "stages"}`}
          >
            <div className="bot-workflows__flow-summary">
              {draft.stages.map((st, i) => (
                <div key={st.id} className="bot-workflows__flow-step">
                  <div className="bot-workflows__flow-node">
                    <span className="bot-workflows__flow-num">{i + 1}</span>
                    <span className="bot-workflows__flow-title">{st.name || `Stage ${i + 1}`}</span>
                    <span className="bot-workflows__flow-agent">{st.agentId}</span>
                    {st.worktree?.isolate !== false && (
                      <span className="bot-workflows__flow-badge" title="Isolated Git Worktree">
                        <Icon name="gitBranch" size={10} />
                        <span>worktree</span>
                      </span>
                    )}
                  </div>
                  {i < draft.stages.length - 1 && (
                    <span className="bot-workflows__flow-sep" aria-hidden="true">
                      <Icon name="chevronRight" size={13} className="bot-workflows__flow-arrow" />
                    </span>
                  )}
                </div>
              ))}
            </div>
          </FormSection>

          {/* Pipeline Stages Section */}
          <FormSection
            title={`Pipeline Stages (${draft.stages.length})`}
            action={
              <button type="button" className="btn btn--subtle btn--sm" onClick={addStage}>
                <Icon name="plus" size={12} />
                <span>Add Stage</span>
              </button>
            }
          >
            <div className="bot-stage-cards">
              {draft.stages.map((stage, idx) => {
                const agentDesc = availableAgents.find((a) => a.id === stage.agentId);
                const models = agentDesc?.availableModels ?? [];

                return (
                  <div key={stage.id} className="bot-stage-card">
                    {/* Stage Card Header */}
                    <div className="bot-stage-card__head">
                      <div className="bot-stage-card__head-left">
                        <span className="bot-stage-card__num">{idx + 1}</span>
                        <input
                          type="text"
                          className="input bot-stage-card__name-input"
                          placeholder={`Stage ${idx + 1} Name`}
                          value={stage.name}
                          onChange={(e) => updateStage(idx, { name: e.target.value })}
                        />
                      </div>

                      <div className="bot-stage-card__head-actions">
                        <button
                          type="button"
                          className="icon-btn icon-btn--small"
                          disabled={idx === 0}
                          onClick={() => moveStage(idx, -1)}
                          title="Move stage up"
                        >
                          <Icon name="arrowUp" size={12} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn--small"
                          disabled={idx === draft.stages.length - 1}
                          onClick={() => moveStage(idx, 1)}
                          title="Move stage down"
                        >
                          <Icon name="arrowDown" size={12} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn--small icon-btn--danger"
                          disabled={draft.stages.length <= 1}
                          onClick={() => removeStage(idx)}
                          title="Delete stage"
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </div>
                    </div>

                    {/* Stage Card Grid: Agent & Model */}
                    <div className="bot-stage-card__grid">
                      <Field
                        label="Assigned External Agent"
                        hint="Detected CLI or ACP binary runner"
                      >
                        <select
                          className="select"
                          value={stage.agentId}
                          onChange={(e) =>
                            updateStage(idx, { agentId: e.target.value, modelOverride: undefined })
                          }
                        >
                          {availableAgents.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} {a.installed ? `(Detected: ${a.version ?? "Ready"})` : "(Not installed)"}
                            </option>
                          ))}
                          {!availableAgents.some((a) => a.id === stage.agentId) && (
                            <option value={stage.agentId}>{stage.agentId}</option>
                          )}
                        </select>
                      </Field>

                      <Field
                        label="Model Selector"
                        hint="Override specific model or use agent default"
                      >
                        <select
                          className="select"
                          value={stage.modelOverride ?? ""}
                          onChange={(e) =>
                            updateStage(idx, { modelOverride: e.target.value || undefined })
                          }
                        >
                          <option value="">Default model for agent</option>
                          {models.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>

                    {/* Prompt Template */}
                    <Field
                      label="Prompt Template"
                      hint="Instructions passed to the external agent. Supports interpolated variables."
                      actions={
                        <div className="bot-stage-card__var-chips">
                          <span className="bot-stage-card__var-label">Variables:</span>
                          <button
                            type="button"
                            className="chip chip--small"
                            onClick={() => insertVariable(idx, "{{artifacts}}")}
                            title="Insert shared artifacts context"
                          >
                            + artifacts
                          </button>
                          {idx > 0 && (
                            <button
                              type="button"
                              className="chip chip--small"
                              onClick={() =>
                                insertVariable(idx, `{{stage.${draft.stages[idx - 1]!.id}.output}}`)
                              }
                              title={`Insert output from Stage ${idx}`}
                            >
                              + stage.{draft.stages[idx - 1]!.id}.output
                            </button>
                          )}
                          <button
                            type="button"
                            className="chip chip--small"
                            onClick={() => insertVariable(idx, "{{inputs.goal}}")}
                            title="Insert overall user goal"
                          >
                            + goal
                          </button>
                        </div>
                      }
                    >
                      <textarea
                        className="input input-mono bot-stage-card__prompt"
                        rows={3}
                        value={stage.userPromptTemplate}
                        onChange={(e) => updateStage(idx, { userPromptTemplate: e.target.value })}
                        placeholder="Instructions for this stage..."
                      />
                    </Field>

                    {/* Card Footer: Ephemeral Worktree & Watchdog Timers */}
                    <div className="bot-stage-card__foot">
                      <label className="bot-stage-card__toggle-label">
                        <Toggle
                          checked={stage.worktree?.isolate !== false}
                          onChange={(checked) =>
                            updateStage(idx, {
                              worktree: { ...stage.worktree, isolate: checked },
                            })
                          }
                        />
                        <span className="bot-stage-card__toggle-text">
                          Isolate in Ephemeral Git Worktree
                        </span>
                      </label>

                      <div className="bot-stage-card__watchdogs">
                        <div className="bot-stage-card__watchdog-group">
                          <span className="bot-stage-card__watchdog-label">Timeout</span>
                          <div className="bot-stage-card__input-unit">
                            <input
                              type="number"
                              min={1}
                              className="input bot-stage-card__input-mini"
                              value={Math.round((stage.watchdog?.timeoutMs ?? 900_000) / 60_000)}
                              onChange={(e) =>
                                updateStage(idx, {
                                  watchdog: {
                                    ...stage.watchdog,
                                    timeoutMs: Math.max(1, Number(e.target.value)) * 60_000,
                                  },
                                })
                              }
                            />
                            <span className="bot-stage-card__unit">min</span>
                          </div>
                        </div>

                        <div className="bot-stage-card__watchdog-group">
                          <span className="bot-stage-card__watchdog-label">Stall Alert</span>
                          <div className="bot-stage-card__input-unit">
                            <input
                              type="number"
                              min={10}
                              className="input bot-stage-card__input-mini"
                              value={Math.round((stage.watchdog?.stallThresholdMs ?? 120_000) / 1000)}
                              onChange={(e) =>
                                updateStage(idx, {
                                  watchdog: {
                                    ...stage.watchdog,
                                    stallThresholdMs: Math.max(10, Number(e.target.value)) * 1000,
                                  },
                                })
                              }
                            />
                            <span className="bot-stage-card__unit">sec</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </FormSection>

          {/* Routine Scheduler FormSection */}
          <FormSection title="Routine Scheduler" note="Automated background runs">
            <SettingCard
              title="Enable Routine Scheduler"
              description="Automatically trigger this pipeline on an hourly/daily cron schedule or interval"
            >
              <Toggle
                checked={draft.schedule?.enabled ?? false}
                onChange={(enabled) =>
                  updateDraft({
                    schedule: {
                      enabled,
                      cronExpression: draft.schedule?.cronExpression ?? "0 * * * *",
                      intervalMinutes: draft.schedule?.intervalMinutes ?? 60,
                    },
                  })
                }
              />
            </SettingCard>

            {draft.schedule?.enabled && (
              <div className="bot-workflows__schedule-grid">
                <Field
                  label="Cron Expression"
                  hint="Standard 5-part cron syntax (e.g. 0 * * * * for hourly)"
                >
                  <input
                    type="text"
                    className="input input-mono"
                    placeholder="0 * * * *"
                    value={draft.schedule.cronExpression ?? ""}
                    onChange={(e) =>
                      updateDraft({
                        schedule: { ...draft.schedule!, cronExpression: e.target.value },
                      })
                    }
                  />
                </Field>

                <Field
                  label="Interval (minutes)"
                  hint="Fallback interval timer between workflow executions"
                >
                  <input
                    type="number"
                    min={1}
                    className="input"
                    value={draft.schedule.intervalMinutes ?? 60}
                    onChange={(e) =>
                      updateDraft({
                        schedule: {
                          ...draft.schedule!,
                          intervalMinutes: Math.max(1, Number(e.target.value)),
                        },
                      })
                    }
                  />
                </Field>
              </div>
            )}
          </FormSection>
        </div>
      </section>
    </div>
  );
}
