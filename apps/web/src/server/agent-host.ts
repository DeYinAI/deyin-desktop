import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AgentShell,
  SessionEventJournal,
  TerminalManager,
  createImageBridge,
  storeAttachedImages,
  type ImageModelChoice,
} from "@deyin/host-core";
import type { GatedArtifactStore } from "./gated-artifacts.js";
import type { AgentEventEnvelope, AgentImageInput, AgentTodoItem, AgentUiEvent, ChatMode } from "@deyin/host-core/shared";
import {
  PermissionEngine,
  agentForMode,
  buildSystemPromptParts,
  createRoleRouter,
  createTaskTool,
  resolveCommandInvocation,
  unknownCommandMessage,
  getSessionJobsManager,
  loadContextFiles,
  matchCommand,
  modeReminder,
  rulesForApprovalMode,
  runAgent,
  runSubagent,
  skipPromptsForApproval,
  subagentReadonlyRules,
  estimateContextUsage,
  type AgentEvent,
  type AgentMessage,
  type CapabilitySnapshot,
  type ImageGenBridge,
  type PermissionDecision,
  type PermissionEngineOptions,
  type SubagentDefinition,
  type ToolRegistry,
  type ToolSessionMeta,
} from "@deyin/agent-core";
import { truncateToolResultUi } from "@deyin/contract";
import { PluginKernel } from "@deyin/kernel";
import { bundleBase, registerBasePlugins } from "@deyin/bundle-base";
import { createWebProfile } from "@deyin/bundle-web-app";
import { buildPromptCacheKeyFor, resolveWireProvider, type ReasoningEffort } from "@deyin/host-core/shared";
import {
  Optimization,
  bindAgentCacheHooks,
  optimizationPluginDef,
  type OptimizationPlugin,
} from "@deyin/optimization-plugin";
import { Capabilities, capsLocalPlugin } from "@deyin/plugin-caps-local";
import { buildToolRegistry, Tools } from "@deyin/tools";
import type { WebAgentProviderRouting } from "@deyin/contract/web";

/** Mirrors the desktop's prompt bridge timeout: unanswered prompts deny after 5 minutes. */
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
/** Files bigger than this ship to the renderer without diff content. */
const FILE_DIFF_CAP = 400_000;

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface WebAgentStartOptions {
  threadId: string;
  prompt: string;
  model: string;
  thinking: boolean;
  effort?: ReasoningEffort;
  approvalMode: "full-access" | "ask-first" | "read-only";
  mode: ChatMode;
  history: { role: "user" | "assistant"; content: string }[];
  provider: WebAgentProviderRouting;
  /** Per-phase model overrides: role -> "providerId::modelId". */
  roleModels?: Record<string, string>;
  /** Endpoints for every provider a role model targets, keyed by provider id. */
  roleProviders?: Record<string, WebAgentProviderRouting>;
  /** Seed the loop's todo list (plan todos handed to Build). */
  initialTodos?: AgentTodoItem[];
  /** Active goal text; enables report_goal_met verification. */
  goalText?: string;
  /** Images attached to this run's user message (vision). */
  images?: AgentImageInput[];
  /** Text-to-image model ids from the client's catalog (generate_image). */
  imageModels?: string[];
  /** Chat model ids that return pictures inside their completion. */
  imageChatModels?: string[];
  /** Must match the renderer's active run id so stale events are ignored after stop/restart. */
  runId?: string;
  /** Model context window from the client catalog (tokens). */
  contextLength?: number;
  /** Capability ids the user disabled in settings (skill:, command:, subagent:, …). */
  disabledCaps?: string[];
 /** Step cap for this run; null = unlimited (from the client's step-limit setting). */
 maxSteps?: number | null;
}

interface ActiveRun {
  abort: AbortController;
  doneEmitted: boolean;
  runId?: string;
}

interface PendingPrompt<T> {
  threadId: string;
  resolve: (value: T) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs the agent-core loop inside one web session's sandbox root. Provider
 * credentials arrive per run (from the browser's stored keys) and are never
 * persisted; tool + terminal activity stays confined to the sandbox.
 */
export class WebAgentHost {
  private active = new Map<string, ActiveRun>();
  private shells = new Map<string, AgentShell>();
  /** Per-thread "allow for session" grants, so they outlive a single run. */
  private permissionGrants = new Map<string, Set<string>>();
  private pendingPermissions = new Map<string, PendingPrompt<PermissionDecision>>();
  private pendingQuestions = new Map<string, PendingPrompt<Record<string, string | string[]>>>();
  /** Per-session plugin kernel: base bundle + sandbox-scoped capabilities. */
  private kernelPromise: Promise<PluginKernel> | null = null;
  /** Lazily activated optimization plugin (semantic caches); null when off/failed. */
  private optimizationPlugin: OptimizationPlugin | null = null;
  private optimizationPluginLoading: Promise<OptimizationPlugin | null> | null = null;
  /** Append-only event journal inside the sandbox (session-event-log spine). */
  private readonly journal: SessionEventJournal;

  constructor(
    private readonly root: string,
    private readonly terminals: TerminalManager,
    private readonly send: (envelope: AgentEventEnvelope) => void,
    private readonly emitTerminal: (msg: { type: "term.data"; termId: string; data: string } | { type: "term.exit"; termId: string; exitCode: number }) => void,
    /** Live repo branch info (null until a repository is connected). */
    private readonly repoInfo: () => { branch: string; defaultBranch: string } | null = () => null,
    /** User-gated image/page artifacts (local cache + optional R2). */
    private readonly artifacts?: GatedArtifactStore,
  ) {
    this.journal = new SessionEventJournal(join(this.root, "journal"));
  }

  /**
   * One kernel per web session, composed from bundle:base + the web profile:
   * tool families and llm adapters from the shared base, capabilities scanned
   * strictly inside the sandbox (userDir = sandbox root, never the server's
   * home), so workspace .deyin skills/commands/subagents work on the web.
   */
  private ensureKernel(): Promise<PluginKernel> {
    this.kernelPromise ??= (async () => {
      const kernel = registerBasePlugins(
        new PluginKernel({
          env: { app: "web", platform: process.platform, userDataPath: this.root, workspaceRoot: this.root },
        }),
      );
      kernel.register(capsLocalPlugin);
      const statuses = await kernel.start([bundleBase, createWebProfile({ sandboxRoot: this.root })]);
      for (const failed of statuses.filter((s) => s.state === "failed")) {
        console.warn(`[deyin:web] plugin "${failed.name}" failed to activate: ${failed.error}`);
      }
      return kernel;
    })();
    return this.kernelPromise;
  }

  /**
   * Lazily activate the optimization plugin (semantic tool/response caches).
   * Web sessions enable it by default — the sandbox keeps its data isolated.
   */
  private async ensureOptimizationPlugin(): Promise<OptimizationPlugin | null> {
    if (this.optimizationPlugin) return this.optimizationPlugin;
    if (!this.optimizationPluginLoading) {
      this.optimizationPluginLoading = (async () => {
        try {
          const kernel = await this.ensureKernel();
          const status = await kernel.activatePlugin(optimizationPluginDef.name);
          if (status.state === "failed") {
            throw new Error(status.error ?? "optimization plugin failed to activate");
          }
          const plugin = kernel.get(Optimization);
          this.optimizationPlugin = plugin;
          return plugin;
        } catch (err) {
          console.warn("[deyin:web] optimization plugin failed to load:", err);
          return null;
        } finally {
          this.optimizationPluginLoading = null;
        }
      })();
    }
    return this.optimizationPluginLoading;
  }

  start(options: WebAgentStartOptions): void {
    void this.startRun(options).catch((err) => {
      this.emit(options.threadId, { type: "error", message: err instanceof Error ? err.message : String(err) }, options.runId);
      this.finish(options.threadId, "aborted", "", options.runId);
    });
  }

  stop(threadId: string): void {
    const run = this.active.get(threadId);
    if (!run) return;

    for (const [requestId, pending] of [...this.pendingPermissions]) {
      if (pending.threadId !== threadId) continue;
      this.pendingPermissions.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve("deny");
    }
    for (const [requestId, pending] of [...this.pendingQuestions]) {
      if (pending.threadId !== threadId) continue;
      this.pendingQuestions.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({ __cancelled: "AskQuestion was cancelled before answers were returned." });
    }

    run.abort.abort();
    // Emit `done` immediately and free the slot so interrupt-and-send can start
    // a new run without waiting on a hung tool/stream.
    if (!run.doneEmitted) {
      run.doneEmitted = true;
      this.active.delete(threadId);
      this.emit(threadId, { type: "done", reason: "aborted", finalText: "" }, run.runId);
    }
  }

  /** Dispose the persistent shell for a thread (e.g. thread archived). */
  disposeShell(threadId: string): void {
    const shell = this.shells.get(threadId);
    if (!shell) return;
    this.terminals.unregister(shell.id);
    shell.dispose();
    this.shells.delete(threadId);
  }

  approve(requestId: string, decision: PermissionDecision): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);
    pending.resolve(decision);
  }

  answerQuestion(requestId: string, answers: Record<string, string | string[]>): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingQuestions.delete(requestId);
    pending.resolve(answers);
  }

  dispose(): void {
    for (const threadId of [...this.active.keys()]) this.stop(threadId);
    for (const shell of this.shells.values()) {
      this.terminals.unregister(shell.id);
      shell.dispose();
    }
    this.shells.clear();
    this.permissionGrants.clear();
    void this.kernelPromise?.then((kernel) => kernel.dispose());
    this.kernelPromise = null;
  }

  private emit(threadId: string, event: AgentUiEvent, runId?: string): void {
    const activeRunId = runId ?? this.active.get(threadId)?.runId;
    this.send({
      threadId,
      ...(activeRunId !== undefined ? { runId: activeRunId } : {}),
      event,
    });
    // Journal first, send after: an append failure must never drop the live
    // event, so failures are swallowed (the journal is a durable shadow).
    void this.journal.append(threadId, event).catch(() => undefined);
  }

  private finish(
    threadId: string,
    reason: "completed" | "max-steps" | "aborted",
    finalText: string,
    runId?: string,
  ): void {
    const run = this.active.get(threadId);
    if (!run || run.doneEmitted) return;
    run.doneEmitted = true;
    this.active.delete(threadId);
    this.emit(threadId, { type: "done", reason, finalText }, runId ?? run.runId);
  }

  private async startRun(options: WebAgentStartOptions): Promise<void> {
    this.stop(options.threadId);
    const runId = options.runId;
    const state: ActiveRun = { abort: new AbortController(), doneEmitted: false, runId };
    this.active.set(options.threadId, state);

    const kernel = await this.ensureKernel();
    const snap = kernel.get(Capabilities).snapshot();
    if (!snap) throw new Error("Capabilities not loaded.");
    const runCaps = enabledForRun(snap, new Set(options.disabledCaps ?? []));

    // Slash-command / skill expansion against the sandbox's own capabilities
    // (same contract as the desktop host).
    let prompt = options.prompt;
    const invocation = matchCommand(prompt);
    if (invocation?.name === "goal") {
      const args = invocation.args.trim();
      prompt = args || options.goalText?.trim() || "What should I work on next?";
    } else {
      const resolved = resolveCommandInvocation(prompt, runCaps);
      if (resolved.kind === "unknown") {
        this.emit(
          options.threadId,
          { type: "error", message: unknownCommandMessage(resolved.name, resolved.suggestions) },
          runId,
        );
        this.finish(options.threadId, "aborted", "", runId);
        return;
      }
      if (resolved.kind !== "none") prompt = resolved.prompt;
    }
    const subagents: SubagentDefinition[] = runCaps.subagents;

    // Live per-run session state: mode tools mutate it so permissions, the
    // system prompt and the UI follow mid-run mode switches (same contract as
    // the desktop host).
    const sessionMeta: ToolSessionMeta = { threadId: options.threadId, mode: options.mode };
    const grants = this.grantsFor(options.threadId);
    const buildPermissions = (mode: ChatMode): PermissionEngineOptions => ({
      agentRules: rulesForApprovalMode(options.approvalMode),
      configRules: agentForMode(mode).permissions ?? [],
      skipAll: skipPromptsForApproval(options.approvalMode, mode),
      sessionGrants: grants,
    });
    const permissions = new PermissionEngine(buildPermissions(options.mode));

    const jobsMgr = getSessionJobsManager(options.threadId, join(this.root, ".deyin", "jobs"));
    const registry = await this.buildRegistry(options, subagents, jobsMgr);
    // Attached pictures also land in the session image store, so generate_image
    // can edit them by file name instead of drawing something new.
    const attachedImages =
      options.images?.length && this.artifacts
        ? storeAttachedImages(this.artifacts.images, options.threadId, options.images)
        : { files: [], note: "" };
    if (this.artifacts && attachedImages.files.length > 0) {
      for (const file of attachedImages.files) {
        void this.artifacts.mirrorImageSave(options.threadId, file).catch(() => undefined);
      }
    }
    const skillSummaries = runCaps.skills;
    const buildPrompt = async (mode: ChatMode): Promise<string> => {
      const parts = buildSystemPromptParts({
        cwd: this.root,
        agent: agentForMode(mode),
        toolNames: registry.names(),
        skills: skillSummaries,
        contextFiles: await loadContextFiles(this.root).catch(() => []),
      });
      let systemPrompt = parts.content;
      const repo = this.repoInfo();
      if (repo) {
        systemPrompt += `\n\n## Git workflow\nYou are working on branch "${repo.branch}" off "${repo.defaultBranch}". Commit your work to this branch as you go. Never push, merge, or open pull requests — the user ships changes with the Ship button.`;
      }
      return systemPrompt;
    };
    // Hoisted so onModeChange can swap the system prompt and append reminders.
    const messages: AgentMessage[] = [
      { role: "system", content: await buildPrompt(options.mode) },
      ...options.history,
      {
        role: "user",
        content: prompt + attachedImages.note,
        ...(options.images?.length ? { images: options.images } : {}),
      },
    ];

    // Per-phase model routing. The client resolves each role's provider before
    // sending, so a role can target a different endpoint than the run itself;
    // roles whose provider is missing degrade to the run's own endpoint.
    const router = createRoleRouter({
      roleModels: options.roleModels ?? {},
      base: {
        model: options.model,
        providerId: "__run__",
        apiBaseUrl: options.provider.baseUrl,
        getToken: async () => options.provider.token,
        apiFormat: options.provider.apiFormat,
        authHeader: options.provider.authHeader,
        contextLength: options.contextLength,
      },
      resolveProvider: (providerId) => {
        const routing = options.roleProviders?.[providerId];
        if (!routing) return undefined;
        return {
          apiBaseUrl: routing.baseUrl,
          getToken: async () => routing.token,
          apiFormat: routing.apiFormat,
          authHeader: routing.authHeader,
        };
      },
      getContextLength: (_providerId, model) =>
        model === options.model ? options.contextLength : undefined,
    });

    const optPlugin = await this.ensureOptimizationPlugin();
    const cacheHooks = optPlugin ? bindAgentCacheHooks(optPlugin) : null;

    const wireProvider = resolveWireProvider({
      providerId: "web-session",
      model: options.model,
      cwd: this.root,
      apiFormat: options.provider.apiFormat,
    });

    const responseCacheContext = {
      model: options.model,
      mode: options.mode,
      systemPromptHash: shortHash(messages[0]?.content ?? ""),
      historyHash: shortHash(
        messages
          .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
          .slice(-8)
          .map((m) => {
            if (m.role === "tool") {
              const body = typeof m.content === "string" ? m.content : "";
              return `tool:${m.toolName ?? ""}:${body.slice(0, 200)}`;
            }
            return `${m.role}:${typeof m.content === "string" ? m.content : ""}`;
          })
          .join("\n"),
      ),
    };
    const responseCacheWorkspace = `${this.root}|${options.threadId}`;

    if (optPlugin) {
      const cached = await optPlugin.beforeAgentRun(
        optPlugin.runtime,
        prompt,
        responseCacheWorkspace,
        responseCacheContext,
      );
      if (cached.hit) {
        if (state.abort.signal.aborted || state.doneEmitted) return;
        messages.push({ role: "assistant", content: cached.response });
        this.emit(
          options.threadId,
          {
            type: "context-snapshot",
            snapshot: estimateContextUsage({
              contextLength: options.contextLength ?? 0,
              messages,
              tools: registry.toWire(),
              wire: {
                enableCompression: true,
                compressionMode: "balanced",
                enablePromptCaching: true,
                provider: wireProvider,
                model: options.model,
              },
              cached: true,
            }),
          },
          runId,
        );
        this.emit(options.threadId, { type: "text-delta", delta: cached.response }, runId);
        this.emit(options.threadId, { type: "usage", totalTokens: 0 }, runId);
        this.emit(
          options.threadId,
          {
            type: "optimization",
            originalInputTokens: 0,
            compressedInputTokens: 0,
            compressionRatio: 1,
            cachedPromptTokens: 0,
            toolCacheHits: 0,
            toolCacheMisses: 0,
            responseCacheHits: 1,
            responseCacheMisses: 0,
            estimatedCostSavingsUsd: 0,
            sessionCacheHit: 0,
            sessionCacheMiss: 0,
          },
          runId,
        );
        this.finish(options.threadId, "completed", cached.response, runId);
        return;
      }
    }

    const result = await runAgent({
      apiBaseUrl: options.provider.baseUrl,
      getToken: async () => options.provider.token,
      apiFormat: options.provider.apiFormat,
      authHeader: options.provider.authHeader,
      model: options.model,
      router,
      contextLength: options.contextLength,
      thinking: options.thinking,
      effort: options.effort,
      messages,
      tools: registry,
      permissions,
      todos: options.initialTodos ? options.initialTodos.map((t) => ({ ...t })) : [],
      resolvePermission: (req) => this.askPermission(options.threadId, req.toolName, req.summary),
      cwd: this.root,
      // Client step-limit setting (older web clients send none → keep the old cap).
      maxSteps: options.maxSteps ?? 100,
      signal: state.abort.signal,
      shell: await this.ensureShell(options.threadId),
      evidenceGatesEnabled: options.mode === "delivery",
      onEvent: (event) => this.forwardEvent(options.threadId, event, runId),
      // Cache parity with desktop: compression + prompt caching + stable cache key.
      wire: {
        enableCompression: true,
        compressionMode: "balanced",
        enablePromptCaching: true,
        provider: wireProvider,
        model: options.model,
      },
      promptCacheKey: buildPromptCacheKeyFor({
        providerId: "web-session",
        model: options.model,
        cwd: this.root,
      }),
      lookupToolCache: cacheHooks?.lookupToolCache,
      storeToolCache: cacheHooks?.storeToolCache,
      imageOutput: (options.imageChatModels ?? []).includes(options.model),
      toolContext: {
        skills: skillSummaries.map((s) => ({ name: s.name, path: s.path, description: s.description })),
        sessionMeta,
        goalText: options.goalText,
        imageGen: this.imageGenBridge(options, state.abort.signal),
        // Plans stay inside the sandbox (never the server's home directory).
        plansDir: join(this.root, ".deyin", "plans"),
        resolveInteraction: (request) =>
          request.type === "ask-question"
            ? this.askQuestion(options.threadId, request)
            : Promise.resolve("Unknown interaction request."),
        onGoalReport: (report) =>
          this.emit(options.threadId, {
            type: "goal-updated",
            goal: {
              text: options.goalText ?? "",
              status: report.met ? ("met" as const) : ("active" as const),
              reportedAt: new Date().toISOString(),
              reason: report.reason,
            },
          }),
        onPlanCreated: (plan) =>
          this.emit(options.threadId, {
            type: "plan-created",
            name: plan.name,
            overview: plan.overview,
            plan: plan.plan,
            filePath: plan.filePath,
          }),
        pageArtifact: this.artifacts
          ? {
              write: async ({ threadId, file, html }) => {
                const written = await this.artifacts!.writePage(threadId, file, html);
                return { fileName: written.title, filePath: written.file, html: written.html };
              },
            }
          : undefined,
        onPageCreated: (page) =>
          this.emit(options.threadId, {
            type: "page-created",
            title: page.title,
            fileName: page.fileName,
            filePath: page.filePath,
            preview: page.preview,
          }),
        onModeChange: async (change) => {
          const previous = (sessionMeta.mode as ChatMode | undefined) ?? options.mode;
          const nextMode = change.target;
          sessionMeta.mode = nextMode;
          options.mode = nextMode;

          // Re-arm the permission engine for the new mode: the prompt alone
          // must never be the only thing keeping plan/ask read-only.
          permissions.reconfigure(buildPermissions(nextMode));

          const reminder = modeReminder(change);
          if (reminder) {
            messages.push({ role: "system", content: `<system_reminder>\n${reminder}\n</system_reminder>` });
          }
          messages[0] = { role: "system", content: await buildPrompt(nextMode) };
          this.emit(options.threadId, { type: "mode-changed", mode: nextMode, previousMode: previous, reminder });

          if (change.event === "exit" && change.previous === "plan") {
            return change.userApproved
              ? "Plan mode exited. The user approved the plan — proceed with implementation."
              : "Plan mode exited. The plan has been presented to the user for approval.";
          }
          return `Switched to ${nextMode} mode.${change.explanation ? ` ${change.explanation}` : ""}`;
        },
        waitForJobs: async (jobIds, blockUntilMs) => {
          const jobs = await jobsMgr.waitFor(jobIds, blockUntilMs);
          return jobs.map((j) => ({
            id: j.id,
            label: j.label,
            status: j.status,
            result: j.result,
            error: j.error,
          }));
        },
      },
    });

    if (optPlugin && result.finalText) {
      await optPlugin
        .afterAgentRun(optPlugin.runtime, prompt, result.finalText, responseCacheWorkspace, responseCacheContext)
        .catch(() => undefined);
    }

    if (!state.doneEmitted) {
      this.finish(options.threadId, result.reason, result.finalText, runId);
    }
  }

  /** Kernel tool catalog + the task tool over sandbox subagents. */
  private async buildRegistry(
    options: WebAgentStartOptions,
    subagents: SubagentDefinition[],
    jobsMgr: ReturnType<typeof getSessionJobsManager>,
  ): Promise<ToolRegistry> {
    const kernel = await this.ensureKernel();
    const registry = buildToolRegistry(kernel.get(Tools));
    // No image model in the client's catalog: drop generate_image rather than
    // advertising a tool whose every call would fail.
    if (!this.artifacts || imageModelChoices(options).length === 0) registry.unregister("generate_image");
    if (subagents.length > 0) {
      registry.register(
        createTaskTool({
          subagents,
          runSubagent: (def: SubagentDefinition, prompt: string, signal?: AbortSignal) =>
            this.runSubagentTask(options, def, prompt, signal),
          onBackgroundStart: (def, subPrompt) =>
            jobsMgr.register({ kind: "task", label: def.name, prompt: subPrompt }).id,
          onBackgroundDone: (jobId, _def, result) => {
            if (!jobId) return;
            jobsMgr.updateStatus(
              jobId,
              result.ok ? "completed" : "failed",
              result.ok ? result.report : undefined,
              result.ok ? undefined : result.report,
            );
          },
        }),
      );
    }
    return registry;
  }

  private async runSubagentTask(
    options: WebAgentStartOptions,
    def: SubagentDefinition,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; report: string }> {
    const subagentId = randomUUID();
    const startedAt = Date.now();
    this.emit(options.threadId, { type: "subagent-start", id: subagentId, name: def.name, prompt: prompt.slice(0, 200) });
    const result = await runSubagent(def, prompt, {
      cwd: this.root,
      parent: { model: options.model, providerId: "web-session", thinking: options.thinking },
      maxStepsDefault: 20,
      parentRouting: {
        apiBaseUrl: options.provider.baseUrl,
        getToken: async () => options.provider.token,
        apiFormat: options.provider.apiFormat,
        authHeader: options.provider.authHeader,
      },
      // Children can draw too: same provider, same session image store.
      imageGen: this.imageGenBridge(options, signal ?? new AbortController().signal),
      // Same contract as the desktop host: subagents inherit the parent's access
      // level and mode, so full access never prompts inside spawned work either.
      permissionEngine: new PermissionEngine({
        agentRules: rulesForApprovalMode(options.approvalMode),
        configRules: [...(agentForMode(options.mode).permissions ?? []), ...subagentReadonlyRules(def)],
        skipAll: skipPromptsForApproval(options.approvalMode, options.mode),
        sessionGrants: this.grantsFor(options.threadId),
      }),
      resolvePermission: (req) => this.askPermission(options.threadId, `${def.name} → ${req.toolName}`, req.summary),
      signal,
      onEvent: (event: AgentEvent) => {
        if (event.type === "tool-start") {
          this.emit(options.threadId, {
            type: "subagent-progress",
            id: subagentId,
            line: `${event.call.name} ${event.summary}`.trim(),
          });
        }
      },
    });
    this.emit(options.threadId, {
      type: "subagent-end",
      id: subagentId,
      name: def.name,
      ok: result.ok,
      ms: Date.now() - startedAt,
      summary: result.report.slice(0, 200),
      // Full-ish body for the Agent panel; the card still shows `summary`.
      report: result.report.slice(0, 20_000),
    });
    return result;
  }

  /**
   * generate_image bridge: the run's provider credential drives the images
   * endpoint and results land in the sandbox image store, which the client reads
   * back over `images.read` to render the picture inline.
   */
  private imageGenBridge(options: WebAgentStartOptions, signal: AbortSignal): ImageGenBridge | undefined {
    const artifacts = this.artifacts;
    if (!artifacts) return undefined;
    const bridge = createImageBridge({
      store: artifacts.images,
      threadId: options.threadId,
      apiBaseUrl: options.provider.baseUrl,
      getToken: async () => options.provider.token,
      models: () => imageModelChoices(options),
      cwd: this.root,
      signal,
    });
    return {
      async generate(request) {
        const refs = await bridge.generate(request);
        for (const ref of refs) {
          await artifacts.mirrorImageSave(options.threadId, ref.file);
        }
        return refs;
      },
      async save(image) {
        const ref = await bridge.save(image);
        await artifacts.mirrorImageSave(options.threadId, ref.file);
        return ref;
      },
    };
  }

  /** The thread's shared "allow for session" set, created on first use. */
  private grantsFor(threadId: string): Set<string> {
    let grants = this.permissionGrants.get(threadId);
    if (!grants) {
      grants = new Set<string>();
      this.permissionGrants.set(threadId, grants);
    }
    return grants;
  }

  private askPermission(threadId: string, toolName: string, summary: string): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        resolve("deny");
      }, PROMPT_TIMEOUT_MS);
      this.pendingPermissions.set(requestId, { threadId, resolve, timer });
      this.emit(threadId, { type: "permission-request", requestId, toolName, summary });
    });
  }

  private askQuestion(
    threadId: string,
    request: { title?: string; questions: Array<{ id: string; prompt: string; allow_multiple?: boolean; options: Array<{ id: string; label: string }> }> },
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingQuestions.delete(requestId);
        resolve("AskQuestion timed out before answers were returned.");
      }, PROMPT_TIMEOUT_MS);
      this.pendingQuestions.set(requestId, {
        threadId,
        resolve: (answers) => resolve(JSON.stringify(answers)),
        timer,
      });
      this.emit(threadId, { type: "question-request", requestId, title: request.title, questions: request.questions });
    });
  }

  /** Persistent per-thread agent PTY; announced so the client terminal can attach. */
  private async ensureShell(threadId: string): Promise<AgentShell | undefined> {
    const existing = this.shells.get(threadId);
    if (existing) return existing;
    const shell = new AgentShell({
      cwd: this.root,
      events: {
        onData: (id, data) => this.emitTerminal({ type: "term.data", termId: id, data }),
        onExit: (id, exitCode) => this.emitTerminal({ type: "term.exit", termId: id, exitCode }),
      },
    });
    try {
      await shell.ensureStarted();
    } catch {
      shell.dispose();
      return undefined; // bash falls back to spawn inside the sandbox
    }
    this.shells.set(threadId, shell);
    this.terminals.register(shell.id, {
      write: (data) => shell.write(data),
      resize: (cols, rows) => shell.resize(cols, rows),
      kill: () => undefined,
      getScrollback: () => shell.getScrollback(),
    });
    this.emit(threadId, { type: "shell-session", terminalId: shell.id, label: "Agent" });
    return shell;
  }

  /** agent-core loop events → the desktop-shaped UI events (same mapping as the desktop host). */
  private forwardEvent(threadId: string, event: AgentEvent, runId?: string): void {
    switch (event.type) {
      case "text-delta":
        this.emit(threadId, { type: "text-delta", delta: event.delta });
        break;
      case "reasoning-delta":
        this.emit(threadId, { type: "reasoning-delta", delta: event.delta });
        break;
      case "model-routed":
        this.emit(threadId, {
          type: "model-routed",
          step: event.step,
          role: event.role,
          model: event.model,
          providerId: event.providerId,
        });
        break;
      case "tool-start":
        this.emit(threadId, { type: "tool-start", callId: event.call.id, name: event.call.name, summary: event.summary, cwd: event.cwd });
        break;
      case "tool-delta":
        this.emit(threadId, { type: "tool-delta", callId: event.call.id, delta: event.delta });
        break;
      case "tool-end":
        this.emit(threadId, {
          type: "tool-end",
          callId: event.call.id,
          name: event.call.name,
          summary: "",
          result: truncateToolResultUi(event.result),
          ok: event.ok,
          denied: event.denied,
          cwd: event.cwd,
        }, runId);
        break;
      case "file-change": {
        const oversized =
          event.change.before.length > FILE_DIFF_CAP || event.change.after.length > FILE_DIFF_CAP;
        this.emit(
          threadId,
          {
            type: "file-change",
            path: event.change.path,
            before: oversized ? "" : event.change.before,
            after: oversized ? "" : event.change.after,
          },
          runId,
        );
        break;
      }
      case "todos":
        this.emit(threadId, { type: "todos", todos: event.todos });
        break;
      case "usage":
        this.emit(threadId, {
          type: "usage",
          totalTokens: event.usage.totalTokens,
          promptTokens: event.usage.promptTokens,
          completionTokens: event.usage.completionTokens,
          cachedPromptTokens: event.usage.cachedPromptTokens ?? 0,
        });
        break;
      case "context-snapshot":
        this.emit(threadId, { type: "context-snapshot", snapshot: event.snapshot });
        break;
      case "optimization":
        this.emit(threadId, {
          type: "optimization",
          originalInputTokens: event.metrics.originalInputTokens,
          compressedInputTokens: event.metrics.compressedInputTokens,
          compressionRatio: event.metrics.compressionRatio,
          cachedPromptTokens: event.metrics.cachedPromptTokens,
          toolCacheHits: event.metrics.toolCacheHits,
          toolCacheMisses: event.metrics.toolCacheMisses,
          responseCacheHits: event.metrics.responseCacheHits,
          responseCacheMisses: event.metrics.responseCacheMisses,
          estimatedCostSavingsUsd: event.metrics.estimatedCostSavingsUsd,
          sessionCacheHit: event.metrics.sessionCacheHit,
          sessionCacheMiss: event.metrics.sessionCacheMiss,
          cacheHitRate: event.metrics.cacheDiagnostics?.hitRate,
          prefixChanged: event.metrics.cacheDiagnostics?.prefixChanged,
          changeReasons: event.metrics.cacheDiagnostics?.changeReasons,
        });
        break;
      case "compaction":
        this.emit(threadId, {
          type: "compaction",
          truncatedToolResults: event.truncatedToolResults,
          truncatedToolArgs: event.truncatedToolArgs,
          droppedMessages: event.droppedMessages,
        });
        break;
      case "evidence-gate":
        this.emit(threadId, { type: "evidence-gate", code: event.code, message: event.message, toolName: event.toolName });
        break;
      default:
        break;
    }
  }
}

/** Image-capable models for this run, dedicated text-to-image models first. */
function imageModelChoices(options: WebAgentStartOptions): ImageModelChoice[] {
  return [
    ...(options.imageModels ?? []).map((id) => ({ id, route: "endpoint" as const })),
    ...(options.imageChatModels ?? []).map((id) => ({ id, route: "chat" as const })),
  ];
}

/** Enabled skills/commands/subagents/hooks for an agent run (desktop parity). */
export function enabledForRun(snap: CapabilitySnapshot, disabled: Set<string>) {
  const pluginEnabled = (source: string) =>
    !source.startsWith("plugin:") || !disabled.has(`plugin:${source.slice("plugin:".length)}`);
  return {
    skills: snap.skills.filter((s) => !disabled.has(`skill:${s.name}`) && pluginEnabled(s.source)),
    commands: snap.commands.filter((c) => !disabled.has(`command:${c.name}`) && pluginEnabled(c.source)),
    subagents: snap.subagents.filter((s) => !disabled.has(`subagent:${s.name}`) && pluginEnabled(s.source)),
    hooks: snap.hooks.filter(
      (h) => !disabled.has(`hook:${h.source}:${h.event}:${shortHash(h.command)}`) && pluginEnabled(h.source),
    ),
  };
}
