import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, app } from "electron";
import {
  AgentShell,
  ShellUnavailableError,
  buildPromptCacheKeyFor,
  resolveWireProvider,
  createImageBridge,
  storeAttachedImages,
  type AgentsStore,
  type ImageModelChoice,
  type MemoryStore,
  type SettingsStore,
  type TerminalManager,
} from "@deyin/host-core";
import {
  PermissionEngine,
  SessionStore,
  appendHookContext,
  buildSystemPromptParts,
  McpConnectionPool,
  createCodebaseSearchTool,
  createTaskTool,
  estimateContextUsage,
  resolveCommandInvocation,
  unknownCommandMessage,
  getSessionJobsManager,
  loadContextFilesCached,
  matchCommand,
  modeReminder,
  runAgent,
  runHooks,
  Semaphore,
  agentForMode,
  rulesForApprovalMode,
  runSubagent,
  skipPromptsForApproval,
  subagentReadonlyRules,
  type AgentMessage,
  type ImageGenBridge,
  type InteractionRequest,
  createRoleRouter,
  type LoadedHook,
  type ModeChangeRequest,
  type McpConnection,
  type PermissionDecision,
  type PlanArtifact,
  type PageArtifact,
  type SubagentDefinition,
  subagentEffort,
  hostToolsForSubagent,
  type SystemPromptBuildResult,
  type SystemPromptSections,
  type ToolDefinition,
  type ToolSessionMeta,
  type ToolShell,
} from "@deyin/agent-core";
import {
  bindAgentCacheHooks,
  Optimization,
  optimizationPluginDef,
  type OptimizationPlugin,
} from "@deyin/optimization-plugin";
import { PluginKernel } from "@deyin/kernel";
import { bundleBase, registerBasePlugins } from "@deyin/bundle-base";
import { createDesktopProfile } from "@deyin/bundle-desktop-app";
import { buildToolRegistry, Tools } from "@deyin/tools";
import type { PermissionEngineOptions, PermissionRule, ProviderApiFormat } from "@deyin/agent-core";
import type { AgentEventEnvelope, AgentStartOptions, AgentUiEvent, ChatMode, IndexSearchHit } from "@deyin/contract";
import { truncateToolResultUi } from "@deyin/contract";
import { CH } from "@deyin/contract";
import type { DeyinConfig } from "@deyin/contract";
import type { AuthManager } from "./auth.js";
import type { BrowserControlService } from "./browser.js";
import type { ComputerUseService } from "./computer-use.js";
import type { CapabilityService } from "./capabilities.js";
import type { VisualizeService } from "./visualize.js";
import type { PageService } from "./page.js";
import type { ImageService } from "./images.js";
import { PendingReviewQueue } from "./pending-review.js";
import { registerBundledHostTools } from "./plugin-host.js";
import { NEVER_SKIP_PREFIXES, NEVER_SKIP_TOOLS } from "./permission-policy.js";
import { workspaceHasDeyinArtifacts, type WorkspaceTrust } from "./workspace-trust.js";
import type { McpAuthBridge, McpOAuthTarget } from "./mcp-auth-bridge.js";
import type { SecurityFindingsStore } from "./security-findings-store.js";
import { wrapSecurityMcpTools } from "./security-mcp-hook.js";
import { createMcpAuthenticateTool, isMcpUnauthorized, resolveMcpModuleId } from "./mcp-auth-bridge.js";

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
/** Files bigger than this ship to the renderer without diff content. */
const FILE_DIFF_CAP = 400_000;

/** Short stable hash for response-cache keying (model|mode|system prompt). */
function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Ping every window that workspace files changed (git/diff refresh). */
function broadcastGitChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CH.gitChanged, undefined);
  }
}

interface ThreadSession {
  sessionId: string;
  messages: AgentMessage[];
  /** Mode the system prompt was built for; a switch rebuilds messages[0]. */
  mode: ChatMode;
  /** Mode before entering plan mode (ExitPlanMode restores this). */
  previousMode?: ChatMode;
  /** Structured system-prompt slices for Context Usage accounting. */
  systemSections?: SystemPromptSections;
  /**
   * Hash of the pinned system prompt. `messages[0]` is only reassigned when a
   * rebuild produces different bytes — the system prompt is the head of the
   * provider's cached prefix, so rewriting it with identical-but-new content
   * would invalidate the system AND message caches on every turn.
   */
  systemPromptHash?: string;
  /**
   * sessionStart hook output, captured once. Re-running these per turn was both
   * semantically wrong (they are *session* start hooks) and a cache buster: a
   * hook that prints a timestamp or `git status` rewrote the system prompt on
   * every single turn.
   */
  startHookContext?: string[];
  /** Persistent PTY for bash tool calls in this thread; created lazily. */
  shell?: AgentShell;
  /** In-flight ensureShell so parallel bash calls share one spawn/register. */
  shellCreating?: Promise<ToolShell | undefined>;
  /** Bumped on disposeShell so in-flight createShell discards orphan PTYs. */
  shellEpoch: number;
  /** True after a hard PTY/bash failure — stop retrying AgentShell for this thread. */
  shellUnavailable?: boolean;
  /** True after the renderer has been told about shell.id. */
  shellAnnounced?: boolean;
  /** "Allow for session" grants; shared with every run's PermissionEngine so they stick. */
  permissionGrants: Set<string>;
}

interface ActiveRun {
  abort: AbortController;
  runId: string;
  /** Set when stop() already emitted `done` so the run finally-path does not double-emit. */
  doneEmitted: boolean;
}

export interface AgentHostOptions {
  config: DeyinConfig;
  auth: AuthManager;
  agents: AgentsStore;
  settings: SettingsStore;
  capabilities: CapabilityService;
  browser: BrowserControlService;
  computerUse: ComputerUseService;
  visualize?: VisualizeService;
  /** One-page website artifact store (create_page tool). */
  pages?: PageService;
  /** Generated-image store (generate_image tool + direct image-model runs). */
  images?: ImageService;
  terminals: TerminalManager;
  /** Background memory store (remember/forget tools + recall). */
  memory: MemoryStore;
  /** Shared change-review queue (review mode) — also surfaced over IPC. */
  review: PendingReviewQueue;
  /** Native OAuth provider store for MCP modules (token-backed connections). */
  mcpAuth?: McpAuthBridge;
  /** Security scan findings store (wraps MCP security tools after connect). */
  security?: SecurityFindingsStore;
  /** Workspace trust decisions (gates hooks.json / mcp.json execution). */
  trust: WorkspaceTrust;
  getWorkspaceRoot: () => string | null;
  searchIndex: (query: string, topK: number) => Promise<IndexSearchHit[]>;
  /** Context window for the model, when known (drives compaction). */
  getContextLength: (providerId: string, modelId: string) => number | undefined;
  /**
   * Image-capable models on a provider, best first: dedicated text-to-image
   * models ("endpoint") and chat models that draw ("chat").
   */
  getImageModels?: (providerId: string) => ImageModelChoice[];
}

/**
 * Hosts the agent-core tool-calling loop in the Electron main process: one
 * transcript per chat thread (persisted as agent-core sessions), tools from
 * the capability registry, approvals bridged to the renderer.
 */
export class DesktopAgentHost {
  private readonly sessions = new Map<string, ThreadSession>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly pendingPermissions = new Map<
    string,
    { threadId: string; resolve: (decision: PermissionDecision) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly pendingQuestions = new Map<
    string,
    { threadId: string; resolve: (answers: string) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly pendingTrust = new Map<
    string,
    { resolve: (decision: "trust" | "skip") => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly agentInbox = new Map<string, string[]>();
  private readonly backgroundTasks = new Map<string, Promise<{ output: string; exitCode: number | null }>>();
  private readonly store: SessionStore;
  /** Caps how many task-tool subagent runs execute in parallel (settings.subagentConcurrency). */
  private readonly subagentLimiter = new Semaphore(() => this.opts.settings.get().subagentConcurrency);
  private optimizationPlugin: OptimizationPlugin | null = null;
  /** The desktop plugin kernel: tools/llm seams + the lazy optimization plugin. */
  private kernelPromise: Promise<PluginKernel> | null = null;
  private optimizationPluginLoading: Promise<OptimizationPlugin | null> | null = null;
  private optimizationPluginLoadError: string | null = null;
  private optimizationPluginLoadErrorNotified = false;
  /**
   * MCP servers live across runs. Reconnecting per message respawned every stdio
   * server and redid OAuth discovery on each turn, stalling the start of the run.
   */
  private readonly mcpPool = new McpConnectionPool();

  constructor(private readonly opts: AgentHostOptions) {
    this.store = new SessionStore(join(app.getPath("userData"), "sessions"));
  }

  /**
   * The desktop kernel boots once from bundle:base + the desktop profile:
   * tool families and llm adapters activate eagerly; optimization stays lazy
   * until its setting flips it on.
   */
  private ensureKernel(): Promise<PluginKernel> {
    this.kernelPromise ??= (async () => {
      const packagedModelDir = join(process.resourcesPath, "optimization-models");
      const kernel = registerBasePlugins(
        new PluginKernel({
          env: {
            app: "desktop",
            platform: process.platform,
            userDataPath: app.getPath("userData"),
          },
        }),
      );
      const statuses = await kernel.start([
        bundleBase,
        createDesktopProfile({
          userDataPath: app.getPath("userData"),
          packagedModelDir: existsSync(packagedModelDir) ? packagedModelDir : undefined,
        }),
      ]);
      for (const failed of statuses.filter((s) => s.state === "failed")) {
        console.warn(`[deyin] plugin "${failed.name}" failed to activate: ${failed.error}`);
      }
      return kernel;
    })();
    return this.kernelPromise;
  }

  private async ensureOptimizationPlugin(): Promise<OptimizationPlugin | null> {
    const settings = this.opts.settings.get();
    const kernel = await this.ensureKernel();
    if (!settings.optimizationPluginEnabled) {
      const status = kernel.status().find((s) => s.name === optimizationPluginDef.name);
      if (status && status.state !== "disposed") {
        await kernel.disposePlugin(optimizationPluginDef.name);
      }
      this.optimizationPlugin = null;
      this.optimizationPluginLoadError = null;
      this.optimizationPluginLoadErrorNotified = false;
      return null;
    }
    if (this.optimizationPlugin) {
      return this.optimizationPlugin;
    }
    // After a failed load, do not re-init on every run (spam + cost). Clear by toggling the setting off/on.
    if (this.optimizationPluginLoadError) {
      return null;
    }
    if (!this.optimizationPluginLoading) {
      this.optimizationPluginLoading = (async () => {
        try {
          const status = await kernel.activatePlugin(optimizationPluginDef.name);
          if (status.state === "failed") {
            throw new Error(status.error ?? "optimization plugin failed to activate");
          }
          const plugin = kernel.get(Optimization);
          this.optimizationPlugin = plugin;
          this.optimizationPluginLoadError = null;
          this.optimizationPluginLoadErrorNotified = false;
          return plugin;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn("[deyin] optimization plugin failed to load:", err);
          this.optimizationPluginLoadError = message;
          return null;
        } finally {
          this.optimizationPluginLoading = null;
        }
      })();
    }
    return this.optimizationPluginLoading;
  }

  /** Resolves the desktop kernel (creating it on demand) for diagnostics. */
  async kernelReady(): Promise<PluginKernel> {
    return this.ensureKernel();
  }

  private send(threadId: string, event: AgentUiEvent): void {
    const runId = this.active.get(threadId)?.runId;
    const envelope: AgentEventEnvelope = { threadId, event, ...(runId ? { runId } : {}) };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CH.agentEvent, envelope);
    }
  }

  /**
   * Lazily create a persistent AgentShell for this thread and announce it to
   * the renderer so an Agent tab can attach. Falls back silently when node-pty
   * is unavailable (bash then uses one-shot spawn). Parallel bash calls in the
   * same step share one in-flight create promise so only one PTY is spawned.
   */
  /**
   * generate_image bridge: routes to the same provider the run uses, defaults to
   * the first text-to-image model in the catalog, and stores every result in the
   * thread's image store so the reply can embed it.
   */
  /**
   * Endpoint + credentials for a provider id. Primary providers use the
   * Openference OAuth token; custom ones use the stored key, and local
   * providers (Ollama) run keyless on an empty token.
   */
  private providerRouting(providerId: string): {
    apiBaseUrl: string;
    getToken: () => Promise<string | null>;
    apiFormat: ProviderApiFormat;
    authHeader?: boolean;
  } {
    const provider = this.opts.agents.listProviders(true).find((p) => p.id === providerId);
    const apiFormat = provider?.apiFormat ?? "chat-completions";
    if (provider && provider.kind === "custom") {
      return {
        apiBaseUrl: provider.baseUrl ?? this.opts.config.apiBaseUrl,
        getToken: () => Promise.resolve(this.opts.agents.getKey(provider.id) ?? (provider.local ? "" : null)),
        apiFormat,
        authHeader: provider.authHeader,
      };
    }
    return {
      apiBaseUrl: this.opts.config.apiBaseUrl,
      getToken: () => this.opts.auth.getAccessToken(),
      apiFormat,
      authHeader: provider?.authHeader,
    };
  }

  private imageGenBridge(
    options: AgentStartOptions,
    apiBaseUrl: string,
    getToken: () => Promise<string | null>,
    cwd: string,
    signal: AbortSignal,
  ): ImageGenBridge | undefined {
    const store = this.opts.images;
    if (!store) return undefined;
    return createImageBridge({
      store,
      threadId: options.threadId,
      apiBaseUrl,
      getToken,
      models: () => this.opts.getImageModels?.(options.providerId) ?? [],
      cwd,
      signal,
    });
  }

  /** True when the run's model returns pictures inside its chat completion. */
  private modelEmitsImages(options: AgentStartOptions): boolean {
    const models = this.opts.getImageModels?.(options.providerId) ?? [];
    return models.some((m) => m.id === options.model && m.route === "chat");
  }

  private async ensureShell(threadId: string, session: ThreadSession, cwd: string): Promise<ToolShell | undefined> {
    if (session.shell) {
      const wasMissing = !this.opts.terminals.isRegistered(session.shell.id);
      this.registerShellTerminal(session.shell);
      // Re-announce after TerminalManager.disposeAll() cleared registrations so a
      // fresh renderer can rebuild agentTerminals / Agent tab affordances.
      if (!session.shellAnnounced || wasMissing) {
        session.shellAnnounced = true;
        this.send(threadId, { type: "shell-session", terminalId: session.shell.id, label: "Agent" });
      }
      return session.shell;
    }
    if (session.shellCreating) return session.shellCreating;

    session.shellCreating = this.createShell(threadId, session, cwd).finally(() => {
      session.shellCreating = undefined;
    });
    return session.shellCreating;
  }

  private registerShellTerminal(shell: AgentShell): void {
    // Idempotent: restores the handle after TerminalManager.disposeAll() clears
    // registered maps without killing the agent PTY (window-all-closed).
    this.opts.terminals.register(shell.id, {
      write: (data) => shell.write(data),
      resize: (cols, rows) => shell.resize(cols, rows),
      kill: () => undefined, // keep shell alive across Agent-tab closes
      getScrollback: () => shell.getScrollback(),
    });
  }

  private async createShell(threadId: string, session: ThreadSession, cwd: string): Promise<ToolShell | undefined> {
    const epoch = session.shellEpoch;
    const sender = () =>
      BrowserWindow.getFocusedWindow()?.webContents ?? BrowserWindow.getAllWindows()[0]?.webContents ?? null;
    const shell = new AgentShell({
      cwd,
      shell: this.opts.settings.get().defaultShell ?? undefined,
      events: {
        onData: (id, data) => sender()?.send(CH.termData, { id, data }),
        onExit: (id, exitCode) => sender()?.send(CH.termExit, { id, exitCode }),
      },
    });

    try {
      await shell.ensureStarted();
    } catch (err) {
      console.warn("[deyin] AgentShell unavailable; falling back to spawn:", err);
      shell.dispose();
      // Permanent host/PTY failure — latch so we stop retrying every bash call.
      if (err instanceof ShellUnavailableError || (err as { name?: string })?.name === "ShellUnavailableError") {
        session.shellUnavailable = true;
      }
      return undefined;
    }

    // disposeShell ran while we were starting — discard this PTY (do not latch unavailable).
    if (session.shellEpoch !== epoch) {
      shell.dispose();
      return undefined;
    }

    session.shell = shell;
    this.registerShellTerminal(shell);
    session.shellAnnounced = true;
    this.send(threadId, { type: "shell-session", terminalId: shell.id, label: "Agent" });
    return shell;
  }

  /** Abort every active run (app quit). Denies pending prompts, closes shells below. */
  stopAll(): void {
    for (const threadId of [...this.active.keys()]) this.stop(threadId);
  }

  /** Dispose the persistent shell for a thread (e.g. thread archived). */
  disposeShell(threadId: string): void {
    // Archiving ends the thread: any queued review change must not survive to a
    // late Approve that would write to disk after the thread is gone.
    this.opts.review.clearThread(threadId);
    const session = this.sessions.get(threadId);
    if (!session) return;
    // Invalidate in-flight createShell without clearing shellCreating (keeps mutex).
    session.shellEpoch += 1;
    if (session.shell) {
      this.opts.terminals.unregister(session.shell.id);
      session.shell.dispose();
      session.shell = undefined;
    }
    session.shellAnnounced = false;
  }

  disposeAllShells(): void {
    for (const threadId of this.sessions.keys()) this.disposeShell(threadId);
  }

  /** App shutdown: stop every run and hang up the pooled MCP servers. */
  async dispose(): Promise<void> {
    this.stopAll();
    this.disposeAllShells();
    for (const [, pending] of this.pendingTrust) clearTimeout(pending.timer);
    this.pendingTrust.clear();
    await this.mcpPool.dispose();
  }

  /** Force a reconnect for one MCP server (e.g. right after it was authorized). */
  reconnectMcpServer(name: string): void {
    void this.mcpPool.invalidate(name);
  }

  /**
   * Hang up every pooled MCP server so the next run reconnects. Used after an
   * authorization change: a pooled client still holds the pre-auth credential.
   */
  resetMcpConnections(): void {
    void this.mcpPool.closeAll();
  }

  isRunning(threadId: string): boolean {
    return this.active.has(threadId);
  }

  stop(threadId: string): void {
    const run = this.active.get(threadId);
    if (!run) return;

    // Permission awaits are not tied to the AbortSignal — deny them so the
    // loop can observe the abort instead of hanging for up to PERMISSION_TIMEOUT_MS.
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
      pending.resolve("AskQuestion was cancelled before answers were returned.");
    }
    for (const [requestId, pending] of [...this.pendingTrust]) {
      this.pendingTrust.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve("skip");
    }

    run.abort.abort();
    // Emit `done` immediately and free the slot so interrupt-and-send can start
    // a new run without waiting on a hung tool/stream.
    if (!run.doneEmitted) {
      run.doneEmitted = true;
      this.active.delete(threadId);
      this.send(threadId, { type: "done", reason: "aborted", finalText: "" });
    }
  }

  approve(requestId: string, decision: PermissionDecision): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
  }

  answerQuestion(requestId: string, answers: Record<string, string | string[]>): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return;
    this.pendingQuestions.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(JSON.stringify(answers, null, 2));
  }

  /** Surface a startup failure to the renderer when start() rejects unexpectedly. */
  sendStartupError(threadId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.send(threadId, { type: "error", message });
    this.send(threadId, { type: "done", reason: "aborted", finalText: "" });
  }

  async start(options: AgentStartOptions): Promise<void> {
    if (this.active.has(options.threadId)) {
      this.send(options.threadId, { type: "error", message: "A run is already in progress for this task." });
      this.send(options.threadId, { type: "done", reason: "aborted", finalText: "" });
      return;
    }
    const abort = new AbortController();
    const runId = options.runId ?? randomUUID();
    const active: ActiveRun = { abort, runId, doneEmitted: false };
    this.active.set(options.threadId, active);
    try {
      await this.run(options, abort.signal, active);
    } catch (err) {
      if (!active.doneEmitted) {
        active.doneEmitted = true;
        this.send(options.threadId, { type: "error", message: err instanceof Error ? err.message : String(err) });
        this.send(options.threadId, { type: "done", reason: "aborted", finalText: "" });
      }
    } finally {
      if (this.active.get(options.threadId) === active) this.active.delete(options.threadId);
    }
  }

  private async run(options: AgentStartOptions, signal: AbortSignal, active: ActiveRun): Promise<void> {
    const cwd = this.opts.getWorkspaceRoot() ?? app.getPath("home") ?? process.cwd();
    let caps = await this.opts.capabilities.enabledForRun();
    const settings = this.opts.settings.get();

    // Workspace trust gate: a cloned repo's hooks.json / mcp.json define shell
    // commands. They run only after a one-time explicit trust decision; an
    // untrusted workspace's hooks and MCP servers are skipped for this run.
    const root = this.opts.getWorkspaceRoot();
    if (root && workspaceHasDeyinArtifacts(root) && !this.opts.trust.isTrusted(root)) {
        const trusted = (await this.askTrust(root)) === "trust";
      if (trusted) {
        this.opts.trust.trust(root);
        this.opts.capabilities.invalidate();
        caps = await this.opts.capabilities.enabledForRun();
      } else {
        caps = {
          ...caps,
          hooks: caps.hooks.filter((h) => h.source !== "workspace"),
          mcpServers: caps.mcpServers.filter((s) => s.source !== "workspace"),
        };
      }
    }

    // Provider routing: primary = Openference OAuth; custom = stored key.
    // Local providers (Ollama) run without a key: pass an empty token through.
    const provider = this.opts.agents.listProviders(true).find((p) => p.id === options.providerId);
    const { apiBaseUrl, getToken } = this.providerRouting(options.providerId);

    // Per-phase model routing: plan/implement/ask/delivery follow the composer
    // mode, and read-only tool churn can fall to a cheap model. Undefined when
    // the user configured no role overrides, which keeps the single-model path.
    const router = createRoleRouter({
      roleModels: settings.roleModels,
      base: {
        model: options.model,
        providerId: options.providerId,
        apiBaseUrl,
        getToken,
        apiFormat: provider?.apiFormat ?? "chat-completions",
        authHeader: provider?.authHeader,
        contextLength: this.opts.getContextLength(options.providerId, options.model),
      },
      resolveProvider: (providerId) => this.providerRouting(providerId),
      getContextLength: (providerId, model) => this.opts.getContextLength(providerId, model),
    });

    // Command / skill expansion (/name args).
    let prompt = options.prompt;
    const invocation = matchCommand(prompt);
    if (invocation?.name === "goal") {
      // Client-side /goal; if it reaches the host, treat the args as the task prompt.
      const args = invocation.args.trim();
      prompt = args || options.goalText?.trim() || "What should I work on next?";
    } else {
      const resolved = resolveCommandInvocation(prompt, caps);
      if (resolved.kind === "unknown") {
        // Claim completion before emitting so a racing stop() cannot also emit `done`.
        active.doneEmitted = true;
        this.send(options.threadId, {
          type: "error",
          message: unknownCommandMessage(resolved.name, resolved.suggestions),
        });
        this.send(options.threadId, { type: "done", reason: "aborted", finalText: "" });
        return;
      }
      if (resolved.kind !== "none") prompt = resolved.prompt;
    }

    // Tools: kernel catalog (bundle:base families) + semantic search + bundled
    // host modules + web search + subagents + MCP.
    const kernel = await this.ensureKernel();
    const registry = buildToolRegistry(kernel.get(Tools));
    // No image model on the plan (or no image store): drop generate_image rather
    // than advertising a tool whose every call would fail.
    if (!this.opts.images || (this.opts.getImageModels?.(options.providerId) ?? []).length === 0) {
      registry.unregister("generate_image");
    }
    if (settings.indexingEnabled) {
      registry.register(createCodebaseSearchTool((query, topK) => this.opts.searchIndex(query, topK)));
    }
    // Bundled host modules (browser/visualize) register their
    // own tools behind their settings + capability toggles, and hand back the
    // extra ask-tier permission rules (e.g. computer-use confirmation).
    const hostRules = await registerBundledHostTools(registry, this.opts.agents, this.opts.settings, {
      browser: this.opts.browser,
      computerUse: this.opts.computerUse,
      visualize: this.opts.visualize,
    }).catch((err) => {
      console.warn("[deyin] bundled host tools failed to register:", err);
      return [] as PermissionRule[];
    });
    const subagents = caps.subagents;
    // Connected lazily inside the run's try/finally so a failure between here
    // and the finally cannot leak spawned MCP child processes.
    const mcpConnections: McpConnection[] = [];
    const mcpAuth = this.opts.mcpAuth;
    const mcpDefs = caps.mcpServers.map((def) => this.opts.capabilities.resolvePluginVariables(def));
    const pendingMcpAuth = new Set<string>();

    const emitMcpAuthNeeded = (target: McpOAuthTarget, message?: string) => {
      if (pendingMcpAuth.has(target.moduleId)) return;
      pendingMcpAuth.add(target.moduleId);
      this.send(options.threadId, {
        type: "mcp-auth-needed",
        requestId: randomUUID(),
        moduleId: target.moduleId,
        serverName: target.displayName,
        message: message ?? "Enables the agent to use custom tools and third-party integrations.",
      });
    };

    if (mcpAuth) {
      registry.register(
        createMcpAuthenticateTool(mcpAuth, (target) => emitMcpAuthNeeded(target)),
      );
    }

    const mcpConnectOpts = {
      onError: (serverName: string, err: unknown) => {
        const def = mcpDefs.find((d) => d.name === serverName);
        const target = def && mcpAuth ? mcpAuth.oauthTargetFor(def) : null;
        if (target && isMcpUnauthorized(err)) {
          console.warn(`[deyin] MCP server "${target.displayName}" skipped — not authenticated.`);
          emitMcpAuthNeeded(target, `${target.displayName} requires authentication before its tools are available.`);
          return;
        }
        console.warn(`[deyin] MCP server "${serverName}" failed to connect:`, err);
      },
      ...(mcpAuth
        ? {
            getAuthProvider: (name: string) => {
              const def = mcpDefs.find((d) => d.name === name);
              const moduleId = def ? resolveMcpModuleId(def) : undefined;
              return moduleId ? mcpAuth.getProvider(moduleId) : undefined;
            },
          }
        : {}),
    };

    // Hooks (custom only, from hooks.json files).
    const hooks = caps.hooks;

    let parentMcpTools: ToolDefinition[] = [];

    try {
      mcpConnections.push(...(await this.mcpPool.acquire(mcpDefs, registry, mcpConnectOpts)));

      if (this.opts.security) {
        wrapSecurityMcpTools(registry, options.threadId, this.opts.security, () => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send(CH.securityFindingsChanged, options.threadId);
          }
        });
      }

      parentMcpTools = registry
        .names()
        .filter((n) => n.startsWith("mcp__"))
        .map((n) => registry.get(n))
        .filter((t): t is ToolDefinition => t != null);

      // Transcript: reuse the in-memory session, else restore/create a persisted one.
      // Built after MCP connect so the system prompt lists connected MCP tools.
      const session = await this.ensureSession(options, cwd, caps.skills.length > 0 ? caps.skills : [], hooks);
      const jobsMgr = getSessionJobsManager(session.sessionId, join(app.getPath("userData"), "jobs"));
      if (subagents.length > 0) {
        registry.register(
          createTaskTool({
            subagents,
            runSubagent: (def, subPrompt, subSignal) =>
              this.runSubagent(options, def, subPrompt, apiBaseUrl, getToken, parentMcpTools, subSignal),
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
      // Attached pictures also land in the thread's image store, so generate_image
      // can edit them by file name instead of drawing something new.
      const attached =
        options.images?.length && this.opts.images
          ? storeAttachedImages(this.opts.images, options.threadId, options.images)
          : { files: [], note: "" };
      session.messages.push({
        role: "user",
        content: prompt + attached.note,
        ...(options.images?.length ? { images: options.images } : {}),
      });
      this.store.append(session.sessionId, { role: "user", content: prompt });

      // Goal mode: the model must be told the objective or report_goal_met can
      // never fire. Injected as the last pre-request message for salience.
      if (options.goalText && options.goalText.trim().length > 0) {
        const goalMsg: AgentMessage = {
          role: "system",
          content:
            `<system_reminder>\nActive goal for this task: ${options.goalText.trim()}\n` +
            `Work toward this goal and nothing else. When — and only when — the objective is verifiably satisfied, ` +
            `call report_goal_met with met=true and a short reason. If it is not yet satisfied, keep working; ` +
            `call report_goal_met with met=false only to report a blocker or that you cannot verify it.\n</system_reminder>`,
        };
        session.messages.push(goalMsg);
        this.store.append(session.sessionId, goalMsg);
      }

      // Two independent axes: the access level (approvalMode chip) provides the base
      // rules; the composer mode's own restrictions come last so plan/ask stay
      // read-only even under "full access". Under full access every build-style
      // mode (agent, delivery) skips prompts entirely — deny rules still win.
      const buildPermissionOptions = (mode: ChatMode): PermissionEngineOptions => ({
        agentRules: [...rulesForApprovalMode(options.approvalMode), ...hostRules],
        configRules: agentForMode(mode).permissions ?? [],
        skipAll: skipPromptsForApproval(options.approvalMode, mode),
        neverSkipTools: NEVER_SKIP_TOOLS,
        neverSkipPrefixes: NEVER_SKIP_PREFIXES,
        // Thread-scoped, so "Allow for session" survives the next message instead
        // of dying with this run's engine.
        sessionGrants: session.permissionGrants,
      });
      const permissions = new PermissionEngine(buildPermissionOptions(options.mode));

      // Persistent PTY shell for bash: created lazily on the first bash tool call
      // (after approval). If node-pty is missing, bash falls back to one-shot spawn.
      const shellBridge: ToolShell = {
        run: async (command, runOpts) => {
          if (session.shellUnavailable) {
            throw new ShellUnavailableError("AgentShell unavailable");
          }
          const shell = await this.ensureShell(options.threadId, session, cwd);
          if (!shell) {
            if (session.shellUnavailable) {
              throw new ShellUnavailableError("AgentShell unavailable");
            }
            // Epoch discard (e.g. archive during create) — must NOT be ShellUnavailableError
            // or bash would fall through to spawn and double-exec the command.
            throw new Error("Agent shell was disposed before it became ready");
          }
          return shell.run(command, runOpts);
        },
      };

      const optPlugin = await this.ensureOptimizationPlugin();
      if (
        this.opts.settings.get().optimizationPluginEnabled &&
        !optPlugin &&
        this.optimizationPluginLoadError &&
        !this.optimizationPluginLoadErrorNotified
      ) {
        this.optimizationPluginLoadErrorNotified = true;
        this.send(options.threadId, {
          type: "error",
          message: `Optimization plugin failed to load: ${this.optimizationPluginLoadError}`,
        });
      }
      const cacheHooks = optPlugin ? bindAgentCacheHooks(optPlugin) : null;
      const systemPromptHash = shortHash(session.messages[0]?.content ?? "");
      const historyHash = shortHash(
        session.messages
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
      );
      const responseCacheContext = {
        model: options.model,
        mode: options.mode,
        systemPromptHash,
        historyHash,
      };
      const responseCacheWorkspace = `${cwd}|${options.threadId}`;
      if (optPlugin) {
        const cached = await optPlugin.beforeAgentRun(optPlugin.runtime, prompt, responseCacheWorkspace, responseCacheContext);
        if (cached.hit) {
          // Claim completion before side effects so stop() cannot interleave an aborted done
          // while we still persist/emit a completed cache replay.
          if (signal.aborted || active.doneEmitted) return;
          active.doneEmitted = true;
          if (signal.aborted) {
            this.send(options.threadId, { type: "done", reason: "aborted", finalText: "" });
            return;
          }
          const assistantMsg = { role: "assistant" as const, content: cached.response };
          session.messages.push(assistantMsg);
          this.store.append(session.sessionId, assistantMsg);
          this.send(options.threadId, {
            type: "context-snapshot",
            snapshot: estimateContextUsage({
              contextLength: this.opts.getContextLength(options.providerId, options.model) ?? 0,
              messages: session.messages,
              systemSections: session.systemSections,
              tools: registry.toWire(),
              // No `compression` here on purpose: this snapshot is emitted on
              // the cached-response path, where no request went out, so there
              // are no wire savings to report. It used to pass `wire` and make
              // the snapshot compress the whole transcript to find that out.
              cached: true,
            }),
          });
          this.send(options.threadId, { type: "text-delta", delta: cached.response });
          // Surface 0-token usage + optimization metrics for the cache hit so the
          // renderer's run footer / usage accounting reflects the saved LLM call.
          this.send(options.threadId, {
            type: "usage",
            totalTokens: 0,
          });
          this.send(options.threadId, {
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
          });
          this.send(options.threadId, { type: "done", reason: "completed", finalText: cached.response });
          await runHooks(hooks, "stop", "stop", { reason: "completed", cwd, fromCache: true });
          return;
        }
      }

      const liveMeta: ToolSessionMeta = {
        threadId: options.threadId,
        mode: session.mode,
        approvalMode: options.approvalMode,
        model: options.model,
        cwd,
      };

      // Review mode: write/edit/delete route through the shared queue and wait
      // for user approval before touching disk; otherwise apply directly.
      const reviewEnabled = this.opts.settings.get().reviewMode === "on";
      const applyFileChange = (request: import("@deyin/agent-core").FileMutationRequest) => {
        const wcId = BrowserWindow.getFocusedWindow()?.webContents.id ?? BrowserWindow.getAllWindows()[0]?.webContents.id ?? 0;
        return this.opts.review.request(
          options.threadId,
          request,
          reviewEnabled,
          wcId,
          (change) => this.send(options.threadId, { type: "pending-change", change }),
          (change) => {
            this.send(options.threadId, {
              type: "file-change",
              path: change.path,
              before: change.before,
              after: change.after,
            });
            broadcastGitChanged();
          },
        );
      };

      const result = await runAgent({
        apiBaseUrl,
        getToken,
        apiFormat: provider?.apiFormat ?? "chat-completions",
        authHeader: provider?.authHeader,
        model: options.model,
        router,
        // User-configurable step cap (null = unlimited; see GeneralPage step limit).
        maxSteps: settings.agentMaxSteps,
        contextLength: this.opts.getContextLength(options.providerId, options.model),
        messages: session.messages,
        tools: registry,
        permissions,
        resolvePermission: (req) => this.askPermission(options.threadId, req.toolName, req.summary),
        cwd,
        thinking: options.thinking,
        effort: options.effort,
        signal,
        imageOutput: this.modelEmitsImages(options),
        todos: options.initialTodos ? options.initialTodos.map((t) => ({ ...t })) : [],
        shell: shellBridge,
        systemSections: session.systemSections,
        memory: settings.memoryEnabled ? this.opts.memory : undefined,
        evidenceGatesEnabled: options.mode === "delivery",
        toolContext: {
          skills: caps.skills.map((s) => ({ name: s.name, path: s.path, description: s.description })),
          imageGen: this.imageGenBridge(options, apiBaseUrl, getToken, cwd, signal),
          sessionMeta: liveMeta,
          memory: settings.memoryEnabled ? this.opts.memory : undefined,
          applyFileChange,
          goalText: options.goalText,
          onGoalReport: (report) => {
            this.send(options.threadId, {
              type: "goal-updated",
              goal: report.met
                ? { text: options.goalText ?? "", status: "met", reportedAt: new Date().toISOString(), reason: report.reason }
                : { text: options.goalText ?? "", status: "active", reportedAt: new Date().toISOString(), reason: report.reason },
            });
          },
          onEvidenceSignOff: (signOff) => {
            this.send(options.threadId, {
              type: "evidence-sign-off",
              stepId: signOff.stepId,
              verificationCommand: signOff.verificationCommand,
              diffSummary: signOff.diffSummary,
              reviewNotes: signOff.reviewNotes,
            });
          },
          resolveInteraction: (request) => this.resolveInteraction(options.threadId, request),
          onPlanCreated: (plan) => this.onPlanCreated(options.threadId, plan),
          pageArtifact: this.opts.pages
            ? {
                write: async ({ threadId, file, html }) => {
                  const written = this.opts.pages!.writePage(threadId, file, html);
                  const content = this.opts.pages!.readPage(threadId, written.title);
                  return { fileName: written.title, filePath: written.file, html: content };
                },
              }
            : undefined,
          onPageCreated: (page) => this.onPageCreated(options.threadId, page),
          onModeChange: async (change) => {
            const result = await this.handleModeChange(
              options.threadId,
              session,
              options,
              change,
              cwd,
              caps.skills,
              hooks,
              permissions,
              buildPermissionOptions,
            );
            liveMeta.mode = session.mode;
            return result;
          },
          sendMessage: async (to, content) => {
            const key = `${options.threadId}:${to}`;
            const list = this.agentInbox.get(key) ?? [];
            list.push(content);
            // Bounded ring: inboxes are diagnostics-only today.
            if (list.length > 50) list.splice(0, list.length - 50);
            this.agentInbox.set(key, list);
            return `Message delivered to ${to}.`;
          },
          pollBackgroundTask: (taskId, blockUntilMs) => this.pollBackgroundTask(taskId, blockUntilMs),
          registerBackgroundTask: (taskId, promise) => {
            this.backgroundTasks.set(taskId, promise);
            void promise.finally(() => this.backgroundTasks.delete(taskId));
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
        wire: {
          enableCompression: true,
          compressionMode: "balanced",
          enablePromptCaching: true,
          provider: resolveWireProvider({
            providerId: options.providerId,
            model: options.model,
            cwd,
            apiFormat: provider?.apiFormat,
          }),
          model: options.model,
        },
        promptCacheKey: buildPromptCacheKeyFor({
          providerId: options.providerId,
          model: options.model,
          cwd,
        }),
        lookupToolCache: cacheHooks?.lookupToolCache,
        storeToolCache: cacheHooks?.storeToolCache,
        onMessage: (message) => this.store.append(session.sessionId, message),
        beforeTool: async (call, args, summary) => {
          const pre = await runHooks(hooks, "preToolUse", call.name, { tool: call.name, args, summary, cwd });
          if (pre.blocked) return { block: pre.reason ?? "preToolUse hook" };
          if (call.name === "bash") {
            const command = typeof args.command === "string" ? args.command : "";
            const shellHook = await runHooks(hooks, "beforeShellExecution", command, { command, cwd });
            if (shellHook.blocked) return { block: shellHook.reason ?? "beforeShellExecution hook" };
          }
          return undefined;
        },
        afterTool: async (call, toolResult, ok) => {
          await runHooks(hooks, "postToolUse", call.name, { tool: call.name, ok, resultChars: toolResult.length, cwd });
          if (call.name === "bash") {
            let args: Record<string, unknown> = {};
            try { args = call.arguments.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {}; } catch { /* ignore */ }
            const command = typeof args.command === "string" ? args.command : "";
            await runHooks(hooks, "afterShellExecution", command, { command, ok, cwd });
          }
          if (ok && (call.name === "write" || call.name === "edit") && optPlugin) {
            try {
              const args = call.arguments.trim() ? (JSON.parse(call.arguments) as { path?: string }) : {};
              if (typeof args.path === "string") optPlugin.onWorkspaceFileChanged(optPlugin.runtime, args.path);
            } catch {
              // ignore parse errors
            }
          }
        },
        onEvent: (event) => {
          switch (event.type) {
            case "text-delta":
              this.send(options.threadId, { type: "text-delta", delta: event.delta });
              break;
            case "reasoning-delta":
              this.send(options.threadId, { type: "reasoning-delta", delta: event.delta });
              break;
            case "tool-start":
              this.send(options.threadId, { type: "tool-start", callId: event.call.id, name: event.call.name, summary: event.summary, cwd: event.cwd });
              break;
            case "tool-delta":
              this.send(options.threadId, { type: "tool-delta", callId: event.call.id, delta: event.delta });
              break;
            case "tool-end":
              this.send(options.threadId, {
                type: "tool-end",
                callId: event.call.id,
                name: event.call.name,
                summary: "",
                result: truncateToolResultUi(event.result),
                ok: event.ok,
                denied: event.denied,
                cwd: event.cwd,
              });
              break;
            case "file-change": {
              // Feeds the renderer's diff view; huge files ship without content
              // (the card still shows, the diff falls back to empty).
              const oversized =
                event.change.before.length > FILE_DIFF_CAP || event.change.after.length > FILE_DIFF_CAP;
              this.send(options.threadId, {
                type: "file-change",
                path: event.change.path,
                before: oversized ? "" : event.change.before,
                after: oversized ? "" : event.change.after,
              });
              break;
            }
            case "todos":
              this.send(options.threadId, { type: "todos", todos: event.todos });
              break;
            case "compaction":
              this.send(options.threadId, {
                type: "compaction",
                kind: event.kind,
                trigger: event.trigger,
                truncatedToolResults: event.truncatedToolResults,
                truncatedToolArgs: event.truncatedToolArgs,
                droppedMessages: event.droppedMessages,
                reclaimedTokens: event.reclaimedTokens,
                ratio: event.ratio,
                summary: event.summary,
              });
              break;
            case "model-routed":
              this.send(options.threadId, {
                type: "model-routed",
                step: event.step,
                role: event.role,
                model: event.model,
                providerId: event.providerId,
              });
              break;
            case "evidence-gate":
              this.send(options.threadId, {
                type: "evidence-gate",
                code: event.code,
                message: event.message,
                toolName: event.toolName,
              });
              break;
            case "loop-guard":
              // Surfaced on the existing gate channel: from the user's point of
              // view this is the same kind of thing — the host stepped in and
              // redirected the model. `code` distinguishes the two.
              this.send(options.threadId, {
                type: "evidence-gate",
                code: `loop-guard:${event.code}`,
                message: event.detail,
              });
              break;
            case "run-summary":
              // The scoring line for a workload: rounds, tool calls, wasted
              // calls, and how much of the prompt the provider served from cache.
              // Journaled into the session log so runs can be scored from disk
              // (scripts/summarize-runs.ts) instead of scraping stdout.
              this.store.appendEvent(session.sessionId, { kind: "run-summary", summary: event.summary });
              console.info(
                `[deyin] run ${options.threadId}: ${event.summary.steps} steps, ` +
                  `${event.summary.toolCalls} tool calls ` +
                  `(${event.summary.deniedCalls} denied, ${event.summary.failedCalls} failed, ` +
                  `${event.summary.duplicateResults} duplicate results elided, ` +
                  `${event.summary.loopGuardTrips} loop-guard trips), ` +
                  `${event.summary.compactionPasses} compaction passes, ` +
                  `cache hit rate ${(event.summary.cacheHitRate * 100).toFixed(1)}%`,
              );
              break;
            case "usage":
              this.send(options.threadId, {
                type: "usage",
                totalTokens: event.usage.totalTokens,
                promptTokens: event.usage.promptTokens,
                completionTokens: event.usage.completionTokens,
                cachedPromptTokens: event.usage.cachedPromptTokens ?? 0,
              });
              break;
            case "context-snapshot":
              // The pressure notice rides on the loop's own `compaction` event
              // (kind: "notice"), which measures against the provider-anchored
              // token count rather than this display estimate.
              this.send(options.threadId, { type: "context-snapshot", snapshot: event.snapshot });
              break;
            case "optimization":
              this.send(options.threadId, {
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
          }
        },
      });

      if (optPlugin && result.finalText) {
        await optPlugin
          .afterAgentRun(optPlugin.runtime, prompt, result.finalText, responseCacheWorkspace, responseCacheContext)
          .catch(() => undefined);
      }

      await runHooks(hooks, "stop", "stop", { reason: result.reason, cwd });
      if (!active.doneEmitted) {
        active.doneEmitted = true;
        this.send(options.threadId, { type: "done", reason: result.reason, finalText: result.finalText });
      }
    } finally {
      // Pooled connections stay up for the next message; `close()` is a no-op
      // here and the pool is hung up on app shutdown (see dispose()).
      for (const conn of mcpConnections) void conn.close().catch(() => undefined);
    }
  }

  /** Fresh, clean-context run for the Task tool, gated by the concurrency cap. */
  private async runSubagent(
    parent: AgentStartOptions,
    def: SubagentDefinition,
    prompt: string,
    apiBaseUrl: string,
    getToken: () => Promise<string | null>,
    parentMcpTools: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; report: string }> {
    return this.subagentLimiter.run(() =>
      this.runSubagentUncapped(parent, def, prompt, apiBaseUrl, getToken, parentMcpTools, signal),
    );
  }

  private async runSubagentUncapped(
    parent: AgentStartOptions,
    def: SubagentDefinition,
    prompt: string,
    apiBaseUrl: string,
    getToken: () => Promise<string | null>,
    parentMcpTools: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; report: string }> {
    const subagentId = randomUUID();
    const startedAt = Date.now();
    this.send(parent.threadId, { type: "subagent-start", id: subagentId, name: def.name, prompt: prompt.slice(0, 200) });
    const cwd = this.opts.getWorkspaceRoot() ?? process.cwd();
    const parentGrants = this.sessions.get(parent.threadId)?.permissionGrants;
    const parentProvider = this.opts.agents.listProviders(true).find((p) => p.id === parent.providerId);
    const parentProviderWire: { apiFormat: ProviderApiFormat; authHeader?: boolean } = {
      apiFormat: parentProvider?.apiFormat ?? "chat-completions",
      authHeader: parentProvider?.authHeader,
    };
    const result = await runSubagent(def, prompt, {
      cwd,
      parent: { model: parent.model, providerId: parent.providerId, thinking: parent.thinking },
      modelOverride: this.opts.settings.get().subagentModels[def.name],
      effortOverride: subagentEffort(this.opts.settings.get().subagentEfforts[def.name], def.effort),
      maxStepsDefault: this.opts.settings.get().subagentMaxSteps,
      parentRouting: { apiBaseUrl, getToken, apiFormat: parentProviderWire.apiFormat, authHeader: parentProviderWire.authHeader },
      // Children inherit the parent's wire compression + prompt caching.
      wire: {
        enableCompression: true,
        compressionMode: "balanced",
        enablePromptCaching: true,
        provider: parentProvider?.kind === "custom" ? "openai" : "openference",
        model: parent.model,
      },
      // Children can draw too: same provider, same thread image store.
      imageGen: this.imageGenBridge(parent, apiBaseUrl, getToken, cwd, signal ?? new AbortController().signal),
      // Surface the child's tool activity as one-line progress updates.
      onEvent: (event) => {
        if (event.type === "tool-start") {
          this.send(parent.threadId, { type: "subagent-progress", id: subagentId, line: `${event.call.name} ${event.summary}`.trim() });
        }
      },
      resolveProvider: (providerId) => this.providerRouting(providerId),
      // Subagents inherit the parent run's mode restrictions: a plan/ask session
      // must stay read-only even inside a spawned task.
      permissionEngine: new PermissionEngine({
        agentRules: rulesForApprovalMode(parent.approvalMode),
        configRules: [...(agentForMode(parent.mode).permissions ?? []), ...subagentReadonlyRules(def)],
        // Full access covers spawned work too: a readonly definition still has
        // write/edit denied, but its bash rule must not turn into a prompt.
        skipAll: skipPromptsForApproval(parent.approvalMode, parent.mode),
        // Spawned work shares the thread's grants both ways: what the user
        // already allowed is not asked again, and a grant made inside a
        // subagent sticks for the rest of the thread.
        ...(parentGrants ? { sessionGrants: parentGrants } : {}),
      }),
      resolvePermission: (req) => this.askPermission(parent.threadId, `${def.name} → ${req.toolName}`, req.summary),
      extraTools: [
        ...parentMcpTools,
        ...(this.opts.settings.get().indexingEnabled
          ? [createCodebaseSearchTool((query, topK) => this.opts.searchIndex(query, topK))]
          : []),
        ...hostToolsForSubagent(def, { browser: this.opts.browser, computerUse: this.opts.computerUse }, {
          browserEnabled: this.opts.settings.get().browserControlEnabled,
          computerUseEnabled: this.opts.settings.get().computerUseEnabled,
        }),
      ],
      signal,
    });
    this.send(parent.threadId, {
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

  private async ensureSession(
    options: AgentStartOptions,
    cwd: string,
    skills: Parameters<typeof buildSystemPromptParts>[0]["skills"],
    hooks: LoadedHook[],
  ): Promise<ThreadSession> {
    const existing = this.sessions.get(options.threadId);
    if (existing) {
      const modeChanged = existing.mode !== options.mode;
      if (modeChanged && options.mode === "plan") {
        existing.previousMode = existing.mode;
      }
      const parts = await this.systemPromptParts(options.mode, cwd, skills, hooks, existing);
      this.pinSystemPrompt(existing, parts);
      if (modeChanged) {
        const reminder = modeReminder({ event: "enter", target: options.mode, previous: existing.previousMode });
        if (reminder) {
          const reminderMsg: AgentMessage = {
            role: "system",
            content: `<system_reminder>\n${reminder}\n</system_reminder>`,
          };
          existing.messages.push(reminderMsg);
          this.store.append(existing.sessionId, reminderMsg);
        }
        this.send(options.threadId, {
          type: "mode-changed",
          mode: options.mode,
          previousMode: existing.previousMode,
          reminder,
        });
      }
      existing.mode = options.mode;
      return existing;
    }

    const hookState: { startHookContext?: string[] } = {};
    const parts = await this.systemPromptParts(options.mode, cwd, skills, hooks, hookState);
    const messages: AgentMessage[] = [{ role: "system", content: parts.content }];
    // Rebuild prior plain-text turns (post-restart continuity).
    for (const turn of options.history) {
      messages.push({ role: turn.role, content: turn.content });
    }

    const meta = this.store.create({ cwd, model: options.model, agent: agentForMode(options.mode).name });
    for (const message of messages) this.store.append(meta.id, message);
    const session: ThreadSession = {
      sessionId: meta.id,
      messages,
      mode: options.mode,
      systemSections: { system: parts.system, skills: parts.skills, rules: parts.rules },
      systemPromptHash: shortHash(parts.content),
      startHookContext: hookState.startHookContext,
      shellEpoch: 0,
      permissionGrants: new Set<string>(),
    };
    this.sessions.set(options.threadId, session);
    return session;
  }

  /**
   * Install a rebuilt system prompt only when its bytes actually changed.
   *
   * `messages[0]` is the head of the provider's cached prefix: Anthropic's
   * invalidation hierarchy is tools -> system -> messages, so a system rewrite
   * discards the whole conversation cache too. Rebuilding it every turn (which
   * is what this used to do) meant the session never got a single cache hit.
   */
  private pinSystemPrompt(session: ThreadSession, parts: SystemPromptBuildResult): void {
    session.systemSections = { system: parts.system, skills: parts.skills, rules: parts.rules };
    const hash = shortHash(parts.content);
    if (session.systemPromptHash === hash && session.messages[0]?.role === "system") return;
    session.systemPromptHash = hash;
    session.messages[0] = { role: "system", content: parts.content };
  }

  private async systemPromptParts(
    mode: ChatMode,
    cwd: string,
    skills: Parameters<typeof buildSystemPromptParts>[0]["skills"],
    hooks: LoadedHook[],
    /** Carries sessionStart hook output across turns; populated on first use. */
    hookState?: { startHookContext?: string[] },
  ) {
    const agent = agentForMode(mode);
    const contextFiles = await loadContextFilesCached(cwd).catch(() => []);
    let parts = buildSystemPromptParts({
      cwd,
      agent: {
        ...agent,
        prompt:
          agent.prompt +
          " You run inside the Deyin desktop app: the user sees your streamed text and tool cards in the chat timeline.",
      },
      contextFiles,
      skills,
    });

    // sessionStart hooks contribute extra context (counted under Rules). Run
    // them once per session and replay the captured lines afterwards, so a
    // hook with volatile output cannot churn the cached prefix every turn.
    let hookContext = hookState?.startHookContext;
    if (hookContext === undefined) {
      const startHooks = await runHooks(hooks, "sessionStart", "sessionStart", { cwd });
      hookContext = startHooks.additionalContext ?? [];
      if (hookState) hookState.startHookContext = hookContext;
    }
    if (hookContext.length > 0) parts = appendHookContext(parts, hookContext);
    return parts;
  }

  private askPermission(threadId: string, toolName: string, summary: string): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        resolve("deny");
      }, PERMISSION_TIMEOUT_MS);
      this.pendingPermissions.set(requestId, { threadId, resolve, timer });
      this.send(threadId, { type: "permission-request", requestId, toolName, summary });
    });
  }

  /**
   * Workspace trust gate, bridged to the renderer as the same inline prompt
   * card used for tool permissions (replaces the native message box). Times
   * out to "skip" so an unattended window never blocks the run forever.
   */
  private askTrust(root: string): Promise<"trust" | "skip"> {
    return new Promise<"trust" | "skip">((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingTrust.delete(requestId);
        resolve("skip");
      }, PERMISSION_TIMEOUT_MS);
      this.pendingTrust.set(requestId, { resolve, timer });
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(CH.workspaceTrustRequest, { requestId, root });
      }
    });
  }

  /** Renderer decision for the workspace trust prompt. */
  respondTrust(requestId: string, decision: "trust" | "skip"): void {
    const pending = this.pendingTrust.get(requestId);
    if (!pending) return;
    this.pendingTrust.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
  }

  private askQuestion(threadId: string, request: Extract<InteractionRequest, { type: "ask-question" }>): Promise<string> {
    return new Promise<string>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingQuestions.delete(requestId);
        resolve("AskQuestion timed out before answers were returned.");
      }, PERMISSION_TIMEOUT_MS);
      this.pendingQuestions.set(requestId, { threadId, resolve, timer });
      this.send(threadId, {
        type: "question-request",
        requestId,
        title: request.title,
        questions: request.questions,
      });
    });
  }

  private resolveInteraction(threadId: string, request: InteractionRequest): Promise<string> {
    if (request.type === "ask-question") return this.askQuestion(threadId, request);
    return Promise.resolve("Unknown interaction request.");
  }

  private onPlanCreated(threadId: string, plan: PlanArtifact): void {
    this.send(threadId, {
      type: "plan-created",
      name: plan.name,
      overview: plan.overview,
      plan: plan.plan,
      filePath: plan.filePath,
    });
  }

  private onPageCreated(threadId: string, page: PageArtifact): void {
    this.send(threadId, {
      type: "page-created",
      title: page.title,
      fileName: page.fileName,
      filePath: page.filePath,
      preview: page.preview,
    });
  }

  private async handleModeChange(
    threadId: string,
    session: ThreadSession,
    options: AgentStartOptions,
    change: ModeChangeRequest,
    cwd: string,
    skills: Parameters<typeof buildSystemPromptParts>[0]["skills"],
    hooks: LoadedHook[],
    permissions: PermissionEngine,
    buildPermissionOptions: (mode: ChatMode) => PermissionEngineOptions,
  ): Promise<string> {
    const previous = session.mode;
    if (change.event === "enter" && change.target === "plan") {
      session.previousMode = previous;
    }
    const nextMode = change.target;
    session.mode = nextMode;
    options.mode = nextMode;

    // Re-arm the permission engine for the new mode: the prompt alone must never
    // be the only thing keeping plan/ask read-only (full-access skipAll from the
    // previous agent-mode run would otherwise persist).
    permissions.reconfigure(buildPermissionOptions(nextMode));

    const reminder = modeReminder(change);
    if (reminder) {
      const reminderMsg: AgentMessage = {
        role: "system",
        content: `<system_reminder>\n${reminder}\n</system_reminder>`,
      };
      session.messages.push(reminderMsg);
      this.store.append(session.sessionId, reminderMsg);
    }

    const parts = await this.systemPromptParts(nextMode, cwd, skills, hooks, session);
    this.pinSystemPrompt(session, parts);

    this.send(threadId, { type: "mode-changed", mode: nextMode, previousMode: previous, reminder });

    if (change.event === "exit" && change.previous === "plan") {
      return change.userApproved
        ? "Plan mode exited. The user approved the plan — proceed with implementation."
        : "Plan mode exited. The plan has been presented to the user for approval.";
    }
    return `Switched to ${nextMode} mode.${change.explanation ? ` ${change.explanation}` : ""}`;
  }

  private async pollBackgroundTask(taskId: string, blockUntilMs: number): Promise<string> {
    const task = this.backgroundTasks.get(taskId);
    if (!task) return `Unknown background task: ${taskId}`;
    const timeout = new Promise<{ output: string; exitCode: number | null }>((resolve) => {
      setTimeout(() => resolve({ output: "(still running)", exitCode: null }), blockUntilMs);
    });
    const result = await Promise.race([task, timeout]);
    if (result.exitCode === null && result.output === "(still running)") {
      return `Task ${taskId} is still running after ${blockUntilMs}ms.`;
    }
    return `Task ${taskId} finished (exit ${result.exitCode ?? "?"}):\n${result.output}`;
  }
}

