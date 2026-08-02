import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, app } from "electron";
import { AgentShell, ShellUnavailableError, formatUserMessageWithContext, type AgentsStore, type SettingsStore, type TerminalManager } from "@deyin/host-core";
import {
  ASK_AGENT,
  BUILD_AGENT,
  DELIVERY_AGENT,
  PLAN_AGENT,
  Coordinator,
  EvidenceLedger,
  PermissionEngine,
  SessionStore,
  ToolRegistry,
  appendHookContext,
  buildRoutingContext,
  buildSystemPrompt,
  buildSystemPromptParts,
  connectMcpDefinitions,
  createBuiltinRegistry,
  createCodebaseSearchTool,
  createFleetTool,
  createParallelTasksTool,
  createPlannerRegistry,
  createTaskTool,
  createWaitJobsTool,
  estimateContextUsage,
  expandCommand,
  getSessionJobsManager,
  getSessionScheduler,
  loadContextFiles,
  matchCommand,
  normalizeWritePaths,
  plannerPromptWithContext,
  runAgent,
  runHooks,
  type AcquireRequest,
  type AgentDefinition,
  type AgentMessage,
  type AgentRunOptions,
  type AgentRunResult,
  type FileMutationRequest,
  type InteractionRequest,
  type LoadedHook,
  type ModeChangeRequest,
  type McpConnection,
  type PermissionDecision,
  type PermissionRule,
  type PlanArtifact,
  type SubagentDefinition,
  type SystemPromptSections,
  type ToolSessionMeta,
  type ToolShell,
  type WritePathSet,
} from "@deyin/agent-core";
import {
  bindAgentCacheHooks,
  createOptimizationPlugin,
  type OptimizationPlugin,
} from "@deyin/optimization-plugin";
import type { AgentEventEnvelope, AgentStartOptions, AgentUiEvent, ApprovalMode, ChatMode, IndexSearchHit } from "../shared/types.js";
import { truncateToolResultUi } from "../shared/types.js";
import { CH } from "../shared/ipc.js";
import type { DeyinConfig } from "../shared/config.js";
import type { AuthManager } from "./auth.js";
import type { BrowserControlService } from "./browser.js";
import type { ChromeDebugService } from "./chrome-debug.js";
import type { ComputerUseService } from "./computer-use.js";
import type { VisualizeService } from "./visualize.js";
import type { SecurityService } from "./security.js";
import type { CapabilityService } from "./capabilities.js";
import { registerBundledHostTools } from "./plugin-host.js";
import { wrapSecurityMcpTools } from "./security-mcp-hook.js";
import { NEVER_SKIP_PREFIXES, NEVER_SKIP_TOOLS, requiresExtraConfirmation } from "./permission-policy.js";
import { chromeOriginRequiresConsent, originOfUrl } from "./chrome-origins.js";
import { PendingReviewQueue } from "./pending-review.js";
import { logLine } from "./logger.js";
import { reasonixObservability } from "./reasonix-observability.js";
import type { ReasonixMetricsStore } from "@deyin/host-core/shared";

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
/** Files bigger than this ship to the renderer without diff content. */
const FILE_DIFF_CAP = 400_000;

/** Short stable hash for response-cache keying (model|mode|system prompt). */
function shortHash(text: string): string {
 return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
const READONLY_RULES: PermissionRule[] = [
  { tool: "*", action: "deny" },
  { tool: "read", action: "allow" },
  { tool: "grep", action: "allow" },
  { tool: "glob", action: "allow" },
  { tool: "ls", action: "allow" },
  { tool: "websearch", action: "allow" },
  { tool: "web_fetch", action: "allow" },
  { tool: "todo_write", action: "allow" },
  { tool: "todo_read", action: "allow" },
  { tool: "ask_question", action: "allow" },
  { tool: "create_plan", action: "allow" },
  { tool: "enter_plan_mode", action: "allow" },
  { tool: "exit_plan_mode", action: "allow" },
  { tool: "switch_mode", action: "allow" },
  { tool: "skill", action: "allow" },
  { tool: "read_session_context", action: "allow" },
  { tool: "report_goal_met", action: "allow" },
  { tool: "complete_step", action: "allow" },
  { tool: "send_message", action: "allow" },
  { tool: "codebase_search", action: "allow" },
  { tool: "browser_snapshot", action: "allow" },
  { tool: "browser_screenshot", action: "allow" },
  { tool: "browser_console", action: "allow" },
  { tool: "browser_network", action: "allow" },
];

interface ThreadSession {
  sessionId: string;
  messages: AgentMessage[];
  /** Mode the system prompt was built for; a switch rebuilds messages[0]. */
  mode: ChatMode;
  /** Mode before entering plan mode (ExitPlanMode restores this). */
  previousMode?: ChatMode;
  /** Structured system-prompt slices for Context Usage accounting. */
  systemSections?: SystemPromptSections;
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
  /** Delivery mode evidence ledger (persists across turns for this thread). */
  evidenceLedger?: EvidenceLedger;
  /** Two-model coordinator (planner + executor isolated sessions). */
  coordinator?: Coordinator;
}

interface ActiveRun {
  abort: AbortController;
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
  chrome: ChromeDebugService;
  computerUse: ComputerUseService;
  visualize: VisualizeService;
  security: SecurityService;
  terminals: TerminalManager;
  getWorkspaceRoot: () => string | null;
  searchIndex: (query: string, topK: number) => Promise<IndexSearchHit[]>;
  /** Context window for the model, when known (drives compaction). */
  getContextLength: (providerId: string, modelId: string) => number | undefined;
  /** Fired when the global pending-review queue size changes (tray badge). */
  onPendingReviewChanged?: (count: number) => void;
  /** Aggregated Reasonix metrics (optional; desktop host only). */
  reasonixMetrics?: ReasonixMetricsStore;
}

/**
 * Hosts the agent-core tool-calling loop in the Electron main process: one
 * transcript per chat thread (persisted as agent-core sessions), tools from
 * the capability registry, approvals bridged to the renderer.
 */
export class DesktopAgentHost {
  private readonly sessions = new Map<string, ThreadSession>();
  private readonly threadToSession = new Map<string, string>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly pendingPermissions = new Map<
    string,
    {
      threadId: string;
      toolName: string;
      args: Record<string, unknown>;
      resolve: (decision: PermissionDecision) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly pendingQuestions = new Map<
    string,
    { threadId: string; resolve: (answers: string) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly agentInbox = new Map<string, string[]>();
  private readonly backgroundTasks = new Map<string, Promise<{ output: string; exitCode: number | null }>>();
  private readonly store: SessionStore;
  private optimizationPlugin: OptimizationPlugin | null = null;
  private optimizationPluginLoading: Promise<OptimizationPlugin | null> | null = null;
  private optimizationPluginLoadError: string | null = null;
  private optimizationPluginLoadErrorNotified = false;
  private readonly pendingReview = new PendingReviewQueue();
  /** threadId → webContents.id that started the run (review IPC scoping). */
  private readonly threadWebContents = new Map<string, number>();

  constructor(private readonly opts: AgentHostOptions) {
    this.store = new SessionStore(join(app.getPath("userData"), "sessions"));
  }

  private async ensureOptimizationPlugin(): Promise<OptimizationPlugin | null> {
    const settings = this.opts.settings.get();
    if (!settings.optimizationPluginEnabled) {
      if (this.optimizationPlugin) {
        this.optimizationPlugin.dispose();
        this.optimizationPlugin = null;
      }
      this.optimizationPluginLoadError = null;
      this.optimizationPluginLoadErrorNotified = false;
      return null;
    }
    if (this.optimizationPlugin) {
      this.optimizationPlugin.runtime.config.enableToolCache = settings.optimizationToolCache;
      this.optimizationPlugin.runtime.config.enableResponseCache = settings.optimizationResponseCache;
      this.optimizationPlugin.setSimilarityThreshold(settings.optimizationSimilarityThreshold);
      return this.optimizationPlugin;
    }
    // After a failed load, do not re-init on every run (spam + cost). Clear by toggling the setting off/on.
    if (this.optimizationPluginLoadError) {
      return null;
    }
    if (!this.optimizationPluginLoading) {
      this.optimizationPluginLoading = (async () => {
        try {
          const dataDir = join(app.getPath("userData"), "plugins", "optimization");
          const packagedModelDir = join(process.resourcesPath, "optimization-models");
          const plugin = await createOptimizationPlugin({
            dataDir,
            packagedModelDir: existsSync(packagedModelDir) ? packagedModelDir : undefined,
            enableToolCache: settings.optimizationToolCache,
            enableResponseCache: settings.optimizationResponseCache,
            similarityThreshold: settings.optimizationSimilarityThreshold,
          });
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

  private send(threadId: string, event: AgentUiEvent): void {
    const envelope: AgentEventEnvelope = { threadId, event };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CH.agentEvent, envelope);
    }
  }

  private broadcastSecurityFindingsChanged(threadId: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CH.securityFindingsChanged, threadId);
    }
  }

  /**
   * Lazily create a persistent AgentShell for this thread and announce it to
   * the renderer so an Agent tab can attach. Falls back silently when node-pty
   * is unavailable (bash then uses one-shot spawn). Parallel bash calls in the
   * same step share one in-flight create promise so only one PTY is spawned.
   */
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

  /** Dispose the persistent shell for a thread (e.g. thread archived). */
  disposeShell(threadId: string): void {
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

    run.abort.abort();
    this.pendingReview.clearThread(threadId);
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
    if (
      (decision === "allow" || decision === "allow-always") &&
      pending.toolName === "chrome_navigate" &&
      typeof pending.args.url === "string"
    ) {
      const origin = originOfUrl(pending.args.url);
      if (origin) this.opts.chrome.approveOrigin(origin);
    }
    pending.resolve(decision);
  }

  answerQuestion(requestId: string, answers: Record<string, string | string[]>): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return;
    this.pendingQuestions.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(JSON.stringify(answers, null, 2));
  }

  listPendingChanges(threadId?: string) {
    return threadId ? this.pendingReview.list(threadId) : this.pendingReview.listAll();
  }

  approvePendingChange(threadId: string, changeId: string, webContentsId: number): boolean {
    const ok = this.pendingReview.approve(threadId, changeId, webContentsId);
    if (ok) {
      this.send(threadId, { type: "pending-change-resolved", changeId, status: "approved" });
      this.notifyPendingReviewChanged();
    }
    return ok;
  }

  rejectPendingChange(threadId: string, changeId: string, webContentsId: number): boolean {
    const ok = this.pendingReview.reject(threadId, changeId, webContentsId);
    if (ok) {
      this.send(threadId, { type: "pending-change-resolved", changeId, status: "rejected" });
      this.notifyPendingReviewChanged();
    }
    return ok;
  }

  async approveAllPendingChanges(threadId: string, webContentsId: number): Promise<number> {
    const ids = await this.pendingReview.approveAll(threadId, webContentsId);
    for (const changeId of ids) {
      this.send(threadId, { type: "pending-change-resolved", changeId, status: "approved" });
    }
    if (ids.length > 0) this.notifyPendingReviewChanged();
    return ids.length;
  }

  rejectAllPendingChanges(threadId: string, webContentsId: number): number {
    const ids = this.pendingReview.rejectAll(threadId, webContentsId);
    for (const changeId of ids) {
      this.send(threadId, { type: "pending-change-resolved", changeId, status: "rejected" });
    }
    if (ids.length > 0) this.notifyPendingReviewChanged();
    return ids.length;
  }

  private notifyPendingReviewChanged(): void {
    const count = this.pendingReview.listAll().filter((c) => c.status === "pending").length;
    this.opts.onPendingReviewChanged?.(count);
  }

  async start(options: AgentStartOptions, webContentsId?: number): Promise<void> {
    if (this.active.has(options.threadId)) {
      this.send(options.threadId, { type: "error", message: "A run is already in progress for this task." });
      return;
    }
    if (webContentsId !== undefined) {
      this.threadWebContents.set(options.threadId, webContentsId);
    }
    const abort = new AbortController();
    const active: ActiveRun = { abort, doneEmitted: false };
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
      this.threadWebContents.delete(options.threadId);
    }
  }

  private async run(options: AgentStartOptions, signal: AbortSignal, active: ActiveRun): Promise<void> {
    const cwd = this.opts.getWorkspaceRoot() ?? app.getPath("home") ?? process.cwd();
    const caps = await this.opts.capabilities.enabledForRun();
    const settings = this.opts.settings.get();

    // Provider routing: primary = Openference OAuth; custom = stored key.
    const provider = this.opts.agents.listProviders(true).find((p) => p.id === options.providerId);
    let apiBaseUrl = this.opts.config.apiBaseUrl;
    let getToken: () => Promise<string | null> = () => this.opts.auth.getAccessToken();
    if (provider && provider.kind === "custom") {
      apiBaseUrl = provider.baseUrl ?? apiBaseUrl;
      getToken = () => Promise.resolve(this.opts.agents.getKey(provider.id));
    }

    // Command / skill expansion (/name args).
    let prompt = options.prompt;
    const invocation = matchCommand(prompt);
    if (invocation) {
      const command = caps.commands.find((c) => c.name === invocation.name);
      const skill = caps.skills.find((s) => s.name === invocation.name);
      if (command) prompt = expandCommand(command, invocation.args);
      else if (skill) {
        prompt = `Read the skill file at ${skill.path} with the read tool and follow it for this task: ${invocation.args || "(no extra arguments)"}`;
      }
    }

    // Tools: built-ins + semantic search + browser + web search + subagents + MCP.
    const registry = createBuiltinRegistry();
    if (settings.indexingEnabled) {
      registry.register(createCodebaseSearchTool((query, topK) => this.opts.searchIndex(query, topK)));
    }
    const hostRules = await registerBundledHostTools(registry, this.opts.agents, this.opts.settings, {
      browser: this.opts.browser,
      chrome: this.opts.chrome,
      computerUse: this.opts.computerUse,
      visualize: this.opts.visualize,
    });
    const subagents = caps.subagents;
    const mcpConnections: McpConnection[] = await connectMcpDefinitions(
      caps.mcpServers.map((def) => this.opts.capabilities.resolvePluginVariables(def)),
      registry,
      {
        onError: (server, err) => {
          console.warn(`[deyin] MCP server "${server}" error:`, err);
          this.send(options.threadId, {
            type: "error",
            message: `MCP server "${server}" failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        },
        getAuthProvider: (name) => this.opts.capabilities.getAuthProvider(name),
      },
    );
    wrapSecurityMcpTools(registry, options.threadId, this.opts.security, () => {
      this.broadcastSecurityFindingsChanged(options.threadId);
    });

    // Hooks (custom only, from hooks.json files).
    const hooks = caps.hooks;

    // Transcript: reuse the in-memory session, else restore/create a persisted one.
    const session = await this.ensureSession(options, cwd, registry, caps.skills.length > 0 ? caps.skills : [], hooks);
    let userContent = options.prompt;
    if (options.linkedContext) {
      userContent = formatUserMessageWithContext(userContent, [], options.linkedContext);
    }
    if (options.goalText) {
      userContent = `[Active goal: ${options.goalText} — call report_goal_met(met=true) only when this objective is verifiably complete]\n\n${userContent}`;
    }
    session.messages.push({ role: "user", content: userContent });
    this.store.append(session.sessionId, { role: "user", content: userContent });

    const scheduler = getSessionScheduler(session.sessionId, {
      maxSubagentConcurrency: settings.maxSubagentConcurrency,
      maxParallelWriters: settings.maxParallelWriters,
    });
    const jobsManager = getSessionJobsManager(session.sessionId, join(app.getPath("userData"), "sessions"));

    const jobNotes = jobsManager.drainCompletionNotes();
    if (jobNotes.length > 0) {
      const noteBlock = jobNotes
        .map((n) => `- [${n.status}] ${n.label} (${n.jobId}): ${n.summary}`)
        .join("\n");
      const notice: AgentMessage = {
        role: "system",
        content: `<system_reminder>\nBackground jobs completed since last turn:\n${noteBlock}\n</system_reminder>`,
      };
      session.messages.push(notice);
      this.store.append(session.sessionId, notice);
    }

    const acquireSlot = (req: AcquireRequest, subSignal?: AbortSignal) => scheduler.acquire(req, subSignal);
    const runSubagentBound = (
      def: SubagentDefinition,
      subPrompt: string,
      subOpts?: { writePaths?: WritePathSet; signal?: AbortSignal; nested?: boolean },
    ) => this.runSubagent(options, def, subPrompt, apiBaseUrl, getToken, subOpts?.signal);

    if (subagents.length > 0) {
      registry.register(
        createTaskTool({
          subagents,
          cwd,
          acquireSlot,
          runSubagent: runSubagentBound,
          onBackgroundDone: (def, result, jobId) => {
            this.send(options.threadId, { type: "subagent-end", name: def.name, ok: result.ok });
            if (jobId) {
              this.send(options.threadId, {
                type: "background-job",
                jobId,
                status: result.ok ? "completed" : "failed",
                label: def.name,
              });
            }
          },
        }),
      );
      if (subagents.length >= 2 && settings.enableFleet) {
        registry.register(
          createFleetTool({
            subagents,
            cwd,
            acquireSlot,
            runSubagent: runSubagentBound,
            validateWritePaths: settings.schedulerWritePathValidation,
            onFleetEvent: (event) => {
              logLine("info", `[fleet] ${event.kind}: ${event.detail} (${event.taskCount} tasks)`);
              reasonixObservability.recordFleetEvent(
                options.threadId,
                event.kind === "conflict" ? "conflict" : event.kind,
                event.detail,
                event.taskCount,
              );
              if (event.kind === "complete") {
                const completed = Number.parseInt(event.detail.split("/")[0] ?? "0", 10);
                this.opts.reasonixMetrics?.recordFleetRun(event.taskCount, completed, false);
              }
              if (event.kind === "conflict") {
                this.opts.reasonixMetrics?.recordFleetRun(event.taskCount, 0, true);
              }
            },
          }),
        );
        registry.register(
          createParallelTasksTool({
            subagents,
            acquireSlot: (subSignal) =>
              acquireSlot({ writer: false, writePaths: { paths: [], wholeWorkspace: false, workspaceRoot: cwd }, nested: false }, subSignal),
            runSubagent: (def, p, subSignal) => runSubagentBound(def, p, { signal: subSignal }),
          }),
        );
      }
    }
    registry.register(createWaitJobsTool());

    const reviewEnabled = settings.reviewMode === "on" || options.approvalMode === "ask-first";

    // Two independent axes: the access level (approvalMode chip) provides the base
    // rules; the composer mode's own restrictions come last so plan/ask stay
    // read-only even under "full access". skipAll only ever applies to agent mode.
    const modeAgent = agentForMode(options.mode);
    const permissions = new PermissionEngine({
      agentRules: rulesForMode(options.approvalMode),
      configRules: [...(modeAgent.permissions ?? []), ...hostRules],
      skipAll: options.approvalMode === "full-access" && (options.mode === "agent" || options.mode === "delivery"),
      neverSkipTools: NEVER_SKIP_TOOLS,
      neverSkipPrefixes: NEVER_SKIP_PREFIXES,
    });

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

    try {
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
 if (optPlugin && settings.optimizationResponseCache) {
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
     wire: {
       enableCompression: settings.optimizationCompression,
       compressionMode: settings.optimizationCompressionMode,
       enablePromptCaching: settings.optimizationPromptCaching,
       provider: provider?.kind === "custom" ? "openai" : "openference",
     },
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

      const deliveryMode = settings.enableDeliveryMode && options.mode === "delivery";
      if (deliveryMode && !session.evidenceLedger) {
        session.evidenceLedger = new EvidenceLedger();
      }

      const plannerModel = settings.plannerModel;
      const useCoordinator =
        settings.enableCoordinator &&
        Boolean(plannerModel && plannerModel !== options.model && options.mode === "agent");

      const agentBase = {
        apiBaseUrl,
        getToken,
        contextLength: this.opts.getContextLength(options.providerId, options.model),
        permissions,
        resolvePermission: (req: Parameters<AgentRunOptions["resolvePermission"]>[0]) =>
          this.askPermission(options.threadId, req.toolName, req.summary, req.args),
        forcePermissionPrompt: (req: Parameters<NonNullable<AgentRunOptions["forcePermissionPrompt"]>>[0]) => {
          if (requiresExtraConfirmation(req.toolName, req.args)) return true;
          if (req.toolName === "chrome_navigate" && typeof req.args.url === "string") {
            return chromeOriginRequiresConsent(req.args.url, this.opts.chrome.approvedOrigins());
          }
          return false;
        },
        cwd,
        thinking: options.thinking,
        signal,
        todos: options.initialTodos ? options.initialTodos.map((t) => ({ ...t })) : [],
        goalText: options.goalText,
        evidenceGatesEnabled: deliveryMode,
        evidenceLedger: session.evidenceLedger,
        shell: shellBridge,
        systemSections: session.systemSections,
        wire: {
          enableCompression: settings.optimizationCompression,
          compressionMode: settings.optimizationCompressionMode,
          enablePromptCaching: settings.enableCacheOptimizations && settings.optimizationPromptCaching,
          provider: provider?.kind === "custom" ? ("openai" as const) : ("openference" as const),
        },
        lookupToolCache: cacheHooks?.lookupToolCache,
        storeToolCache: cacheHooks?.storeToolCache,
        beforeTool: async (call: Parameters<NonNullable<AgentRunOptions["beforeTool"]>>[0], args: Record<string, unknown>, summary: string) => {
          const pre = await runHooks(hooks, "preToolUse", call.name, { tool: call.name, args, summary, cwd });
          if (pre.blocked) return { block: pre.reason ?? "preToolUse hook" };
          if (call.name === "bash") {
            const command = typeof args.command === "string" ? args.command : "";
            const shellHook = await runHooks(hooks, "beforeShellExecution", command, { command, cwd });
            if (shellHook.blocked) return { block: shellHook.reason ?? "beforeShellExecution hook" };
          }
          return undefined;
        },
        afterTool: async (call: Parameters<NonNullable<AgentRunOptions["afterTool"]>>[0], toolResult: string, ok: boolean) => {
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
        onEvent: (event: Parameters<NonNullable<AgentRunOptions["onEvent"]>>[0]) => {
          switch (event.type) {
            case "text-delta":
              this.send(options.threadId, { type: "text-delta", delta: event.delta });
              break;
            case "reasoning-delta":
              this.send(options.threadId, { type: "reasoning-delta", delta: event.delta });
              break;
            case "tool-start":
              this.send(options.threadId, { type: "tool-start", callId: event.call.id, name: event.call.name, summary: event.summary });
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
              });
              break;
            case "file-change": {
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
            case "evidence-gate":
              logLine("warn", `[evidence-gate] ${event.code}: ${event.message}`);
              reasonixObservability.recordEvidenceRejection(options.threadId, event.code, event.message);
              this.opts.reasonixMetrics?.recordEvidenceGate(event.code);
              this.send(options.threadId, { type: "evidence-gate", code: event.code, message: event.message });
              break;
            case "usage":
              this.send(options.threadId, { type: "usage", totalTokens: event.usage.totalTokens });
              break;
            case "context-snapshot":
              this.send(options.threadId, { type: "context-snapshot", snapshot: event.snapshot });
              break;
            case "optimization":
              if (event.metrics.prefixShape) {
                const diag = event.metrics.cacheDiagnostics;
                if (diag?.prefixChanged && diag.changeReasons.length > 0) {
                  logLine(
                    "info",
                    `[cache] prefix changed thread=${options.threadId} reasons=${diag.changeReasons.join(",")} hash=${event.metrics.prefixShape.prefixHash}`,
                  );
                }
                reasonixObservability.recordPrefixShape(
                  options.threadId,
                  event.metrics.prefixShape,
                  diag?.changeReasons ?? [],
                  diag?.hit ?? 0,
                  diag?.miss ?? 0,
                );
                this.opts.reasonixMetrics?.recordCacheTurn(
                  diag?.hit ?? 0,
                  diag?.miss ?? 0,
                  Boolean(diag?.prefixChanged),
                  false,
                  event.metrics.estimatedCostSavingsUsd,
                );
              }
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
                cacheHitRate:
                  event.metrics.sessionCacheHit + event.metrics.sessionCacheMiss === 0
                    ? undefined
                    : event.metrics.sessionCacheHit /
                      (event.metrics.sessionCacheHit + event.metrics.sessionCacheMiss),
                prefixChanged: event.metrics.cacheDiagnostics?.prefixChanged,
                changeReasons: event.metrics.cacheDiagnostics?.changeReasons,
              });
              break;
            case "compaction":
              logLine("info", `[cache] compaction thread=${options.threadId} soft=${event.softWarning ?? false}`);
              this.opts.reasonixMetrics?.recordCacheTurn(0, 0, true, !event.softWarning);
              this.send(options.threadId, {
                type: "compaction",
                softWarning: event.softWarning,
                truncatedToolResults: event.truncatedToolResults,
                truncatedToolArgs: event.truncatedToolArgs,
                droppedMessages: event.droppedMessages,
              });
              break;
          }
        },
      };

      const sharedToolContext = {
        skills: caps.skills.map((s) => ({ name: s.name, path: s.path, description: s.description })),
        sessionMeta: liveMeta,
        resolveInteraction: (request: InteractionRequest) => this.resolveInteraction(options.threadId, request),
        onPlanCreated: (plan: PlanArtifact) => this.onPlanCreated(options.threadId, plan),
        onModeChange: async (change: ModeChangeRequest) => {
          const modeResult = await this.handleModeChange(
            options.threadId,
            session,
            options,
            change,
            cwd,
            registry,
            caps.skills,
            hooks,
            permissions,
            hostRules,
          );
          liveMeta.mode = session.mode;
          return modeResult;
        },
        sendMessage: async (to: string, content: string) => {
          const key = `${options.threadId}:${to}`;
          const list = this.agentInbox.get(key) ?? [];
          list.push(content);
          this.agentInbox.set(key, list);
          return `Message delivered to ${to}.`;
        },
        pollBackgroundTask: (taskId: string, blockUntilMs: number) => this.pollBackgroundTask(taskId, blockUntilMs),
        registerBackgroundTask: (taskId: string, promise: Promise<{ output: string; exitCode: number | null }>) => {
          this.backgroundTasks.set(taskId, promise);
          void promise.finally(() => this.backgroundTasks.delete(taskId));
        },
        applyFileChange: (change: FileMutationRequest) =>
          this.pendingReview.request(
            options.threadId,
            change,
            reviewEnabled,
            this.threadWebContents.get(options.threadId) ?? -1,
            (pending) => {
              this.send(options.threadId, { type: "pending-change", change: pending });
              this.notifyPendingReviewChanged();
            },
            (applied) => {
              const oversized =
                applied.before.length > FILE_DIFF_CAP || applied.after.length > FILE_DIFF_CAP;
              this.send(options.threadId, {
                type: "file-change",
                path: applied.path,
                before: oversized ? "" : applied.before,
                after: oversized ? "" : applied.after,
              });
            },
          ),
        onGoalReport: (report: { met: boolean; reason: string }) => {
          if (!options.goalText) return;
          this.send(options.threadId, {
            type: "goal-updated",
            goal: report.met
              ? { text: options.goalText, status: "met" }
              : { text: options.goalText, status: "active" },
          });
        },
        onEvidenceSignOff: (receipt: {
          stepId: string;
          verificationCommand: string;
          diffSummary: string;
          reviewNotes?: string;
        }) => {
          this.opts.reasonixMetrics?.recordEvidenceSignOff();
          this.send(options.threadId, {
            type: "evidence-sign-off",
            stepId: receipt.stepId,
            verificationCommand: receipt.verificationCommand,
            diffSummary: receipt.diffSummary,
            reviewNotes: receipt.reviewNotes,
          });
        },
        scheduler,
        jobsManager,
        registerBackgroundJob: (job: {
          kind: string;
          label: string;
          profile?: string;
          prompt: string;
          run: (signal?: AbortSignal) => Promise<string>;
        }) => {
          const bg = jobsManager.register({
            kind: job.kind,
            label: job.label,
            profile: job.profile,
            prompt: job.prompt,
          });
          void job
            .run(signal)
            .then((runResult) => {
              jobsManager.updateStatus(bg.id, "completed", runResult);
              this.send(options.threadId, {
                type: "background-job",
                jobId: bg.id,
                status: "completed",
                label: job.label,
              });
              logLine("info", `[fleet] background-job completed id=${bg.id} label=${job.label}`);
              reasonixObservability.recordFleetEvent(options.threadId, "background-job", `completed: ${job.label}`);
              this.opts.reasonixMetrics?.recordBackgroundJobCompleted();
            })
            .catch((err) => {
              jobsManager.updateStatus(bg.id, "failed", undefined, err instanceof Error ? err.message : String(err));
              this.send(options.threadId, {
                type: "background-job",
                jobId: bg.id,
                status: "failed",
                label: job.label,
              });
            });
          return bg.id;
        },
        waitForJobs: (jobIds: string[], timeoutMs: number) =>
          jobsManager.waitFor(jobIds, timeoutMs).then((jobs) =>
            jobs.map((j) => ({
              id: j.id,
              label: j.label,
              status: j.status,
              result: j.result,
              error: j.error,
            })),
          ),
        reserveParentWrite: (paths: string[]) => {
          const claim = normalizeWritePaths(cwd, paths);
          return scheduler.reserveParentWrite(claim);
        },
      };

      let result: AgentRunResult;

      if (useCoordinator && plannerModel) {
        if (!session.coordinator) {
          const ctxFiles = await loadContextFiles(cwd);
          const plannerContext = ctxFiles.map((f) => f.content).join("\n\n");
          session.coordinator = new Coordinator(plannerPromptWithContext(plannerContext), session.messages);
        }
        const plannerRegistry = createPlannerRegistry({
          source: registry,
          invokeMcp: async (server, tool, mcpArgs) => {
            const qualified = `mcp__${server}__${tool}`;
            const mcpTool = registry.get(qualified);
            if (!mcpTool) throw new Error(`MCP tool not found: ${qualified}`);
            return mcpTool.execute(mcpArgs, { cwd, todos: [], signal });
          },
        });
        const routingContext = buildRoutingContext(userContent, {
          mode: "agent",
          isSlashCommand: Boolean(invocation),
          hasActiveGoal: Boolean(options.goalText),
        });
        const coordResult = await session.coordinator.run(
          {
            userMessage: userContent,
            routingContext,
            routingPolicy: settings.coordinatorRoutingPolicy,
          },
          {
            executorTools: registry.toWire(),
            onPhase: (e) => this.send(options.threadId, { type: "phase", text: e.phase, detail: e.detail }),
            onDecision: (d) => {
              logLine("info", `[coordinator] route=${d.route} reason=${d.reason} thread=${options.threadId}`);
              reasonixObservability.recordCoordinatorDecision(options.threadId, d.route, d.reason);
              this.send(options.threadId, { type: "coordinator-routing", route: d.route, reason: d.reason });
            },
            onMessage: (which, msg) => {
              if (which === "executor") this.store.append(session.sessionId, msg);
            },
            runPlanner: async ({ plannerMessages, maxSteps }) => {
              try {
                const plannerRun = await runAgent({
                  ...agentBase,
                  model: plannerModel,
                  messages: plannerMessages,
                  tools: plannerRegistry,
                  maxSteps,
                  promptCacheKey: `deyin:${options.providerId}:${plannerModel}:${cwd}:planner`,
                  toolContext: { ...sharedToolContext, todos: [] },
                  onMessage: undefined,
                });
                return { ok: true, plan: plannerRun.finalText };
              } catch (err) {
                return {
                  ok: false,
                  plan: "",
                  error: err instanceof Error ? err.message : String(err),
                };
              }
            },
            runExecutor: async ({ executorMessages }) =>
              runAgent({
                ...agentBase,
                model: options.model,
                messages: executorMessages,
                tools: registry,
                promptCacheKey: `deyin:${options.providerId}:${options.model}:${cwd}`,
                toolContext: sharedToolContext,
                onMessage: (message) => this.store.append(session.sessionId, message),
              }),
          },
        );
        this.opts.reasonixMetrics?.recordCoordinatorRun(
          coordResult.decision.route,
          coordResult.plannerUsed,
          coordResult.executorOnly && coordResult.plannerUsed === false && coordResult.decision.route !== "executor_only",
        );
        result = {
          reason: coordResult.reason,
          finalText: coordResult.finalText,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          steps: 0,
        };
      } else {
        result = await runAgent({
        ...agentBase,
        model: options.model,
        messages: session.messages,
        tools: registry,
        promptCacheKey: `deyin:${options.providerId}:${options.model}:${cwd}`,
        toolContext: sharedToolContext,
        onMessage: (message) => this.store.append(session.sessionId, message),
      });
      }

if (optPlugin && settings.optimizationResponseCache && result.finalText) {
 await optPlugin.afterAgentRun(optPlugin.runtime, prompt, result.finalText, responseCacheWorkspace, responseCacheContext).catch(() => undefined);
 }

      await runHooks(hooks, "stop", "stop", { reason: result.reason, cwd });
      if (!active.doneEmitted) {
        active.doneEmitted = true;
        this.send(options.threadId, { type: "done", reason: result.reason, finalText: result.finalText });
      }
    } finally {
      for (const conn of mcpConnections) void conn.close().catch(() => undefined);
    }
  }

  /** Fresh, clean-context run for the Task tool. */
  private async runSubagent(
    parent: AgentStartOptions,
    def: SubagentDefinition,
    prompt: string,
    apiBaseUrl: string,
    getToken: () => Promise<string | null>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; report: string }> {
    this.send(parent.threadId, { type: "subagent-start", name: def.name, prompt: prompt.slice(0, 200) });
    const cwd = this.opts.getWorkspaceRoot() ?? process.cwd();
    // Subagents get the built-in toolset (no nested task tool → max depth 2).
    const registry = createBuiltinRegistry();
    if (this.opts.settings.get().indexingEnabled) {
      registry.register(createCodebaseSearchTool((query, topK) => this.opts.searchIndex(query, topK)));
    }
    const readonlyRules: PermissionRule[] = def.readonly
      ? [
          { tool: "write", action: "deny" },
          { tool: "edit", action: "deny" },
          { tool: "bash", action: "ask" },
        ]
      : [];
    // Subagents inherit the parent run's mode restrictions: a plan/ask session
    // must stay read-only even inside a spawned task.
    const permissions = new PermissionEngine({
      agentRules: rulesForMode(parent.approvalMode),
      configRules: [...(agentForMode(parent.mode).permissions ?? []), ...readonlyRules],
      skipAll: parent.approvalMode === "full-access" && parent.mode === "agent" && !def.readonly,
      neverSkipTools: NEVER_SKIP_TOOLS,
      neverSkipPrefixes: NEVER_SKIP_PREFIXES,
    });
    const messages: AgentMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt({
          cwd,
          agent: { name: def.name, description: def.description, prompt: def.prompt },
          toolNames: registry.names(),
        }),
      },
      { role: "user", content: prompt },
    ];
    try {
      const result = await runAgent({
        apiBaseUrl,
        getToken,
        model: def.model ?? parent.model,
        messages,
        tools: registry,
        permissions,
        resolvePermission: (req) =>
          this.askPermission(parent.threadId, `${def.name} → ${req.toolName}`, req.summary, req.args),
        cwd,
        thinking: parent.thinking,
        signal,
      });
      this.send(parent.threadId, { type: "subagent-end", name: def.name, ok: true });
      return { ok: true, report: result.finalText || "(subagent returned no text)" };
    } catch (err) {
      this.send(parent.threadId, { type: "subagent-end", name: def.name, ok: false });
      return { ok: false, report: err instanceof Error ? err.message : String(err) };
    }
  }

  private async ensureSession(
    options: AgentStartOptions,
    cwd: string,
    registry: ToolRegistry,
    skills: Parameters<typeof buildSystemPromptParts>[0]["skills"],
    hooks: LoadedHook[],
  ): Promise<ThreadSession> {
    const existing = this.sessions.get(options.threadId);
    if (existing) {
      const modeChanged = existing.mode !== options.mode;
      if (modeChanged && options.mode === "plan") {
        existing.previousMode = existing.mode;
      }
      const parts = await this.systemPromptParts(options.mode, cwd, registry, skills, hooks);
      existing.messages[0] = { role: "system", content: parts.content };
      existing.systemSections = { system: parts.system, skills: parts.skills, rules: parts.rules };
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

    const parts = await this.systemPromptParts(options.mode, cwd, registry, skills, hooks);
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
      shellEpoch: 0,
    };
    this.sessions.set(options.threadId, session);
    this.threadToSession.set(options.threadId, meta.id);
    return session;
  }

  private async systemPromptParts(
    mode: ChatMode,
    cwd: string,
    registry: ToolRegistry,
    skills: Parameters<typeof buildSystemPromptParts>[0]["skills"],
    hooks: LoadedHook[],
  ) {
    const agent = agentForMode(mode);
    const contextFiles = await loadContextFiles(cwd).catch(() => []);
    let parts = buildSystemPromptParts({
      cwd,
      agent: {
        ...agent,
        prompt:
          agent.prompt +
          " You run inside the Deyin desktop app: the user sees your streamed text and tool cards in the chat timeline.",
      },
      toolNames: registry.names(),
      contextFiles,
      skills,
    });

    // sessionStart hooks can contribute extra context (counted under Rules).
    const startHooks = await runHooks(hooks, "sessionStart", "sessionStart", { cwd });
    if (startHooks.additionalContext && startHooks.additionalContext.length > 0) {
      parts = appendHookContext(parts, startHooks.additionalContext);
    }
    return parts;
  }

  private askPermission(
    threadId: string,
    toolName: string,
    summary: string,
    args: Record<string, unknown> = {},
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        resolve("deny");
      }, PERMISSION_TIMEOUT_MS);
      this.pendingPermissions.set(requestId, { threadId, toolName, args, resolve, timer });
      this.send(threadId, { type: "permission-request", requestId, toolName, summary });
    });
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

  private async handleModeChange(
    threadId: string,
    session: ThreadSession,
    options: AgentStartOptions,
    change: ModeChangeRequest,
    cwd: string,
    registry: ToolRegistry,
    skills: Parameters<typeof buildSystemPromptParts>[0]["skills"],
    hooks: LoadedHook[],
    permissions: PermissionEngine,
    hostRules: PermissionRule[],
  ): Promise<string> {
    const previous = session.mode;
    if (change.event === "enter" && change.target === "plan") {
      session.previousMode = previous;
    }
    const nextMode = change.target;
    session.mode = nextMode;
    options.mode = nextMode;

    permissions.reconfigure({
      agentRules: rulesForMode(options.approvalMode),
      configRules: [...(agentForMode(nextMode).permissions ?? []), ...hostRules],
      skipAll: options.approvalMode === "full-access" && (nextMode === "agent" || nextMode === "delivery"),
      neverSkipTools: NEVER_SKIP_TOOLS,
      neverSkipPrefixes: NEVER_SKIP_PREFIXES,
    });

    const reminder = modeReminder(change);
    if (reminder) {
      const reminderMsg: AgentMessage = {
        role: "system",
        content: `<system_reminder>\n${reminder}\n</system_reminder>`,
      };
      session.messages.push(reminderMsg);
      this.store.append(session.sessionId, reminderMsg);
    }

    const parts = await this.systemPromptParts(nextMode, cwd, registry, skills, hooks);
    session.messages[0] = { role: "system", content: parts.content };
    session.systemSections = { system: parts.system, skills: parts.skills, rules: parts.rules };

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

function modeReminder(change: ModeChangeRequest): string {
  if (change.event === "enter") {
    switch (change.target) {
      case "plan":
        return "You have entered plan mode. You MUST NOT modify the workspace. Use read/grep/glob/ls to gather evidence. If the request is ambiguous or you must choose between valid approaches, use the ask_question tool to clarify — NEVER write questions as plain text, as plain-text questions are not presented to the user. Then call todo_write with implementation steps and create_plan or output your final plan as markdown.";
      case "ask":
        return "You are in ask mode. Answer questions and explore the codebase. You MUST NOT modify the workspace or run commands.";
      case "agent":
        return "You are in agent mode. Implement the user's request end to end using all available tools.";
      case "delivery":
        return (
          "You are in delivery mode with evidence gates enabled. Before editing files, call todo_write with acceptanceCriteria on each step. " +
          "After verifying each step with bash, call complete_step before marking todos completed. Do not declare the task finished until all steps are signed off."
        );
    }
  }
  if (change.event === "exit" && change.previous === "plan") {
    return "You have exited plan mode. The plan has been presented to the user for approval.";
  }
  if (change.event === "switch") {
    return modeReminder({ ...change, event: "enter" });
  }
  return "";
}

function rulesForMode(mode: ApprovalMode): PermissionRule[] {
  switch (mode) {
    case "full-access":
      return [];
    case "ask-first":
      // Tier defaults already ask for write/execute; nothing to override.
      return [];
    case "read-only":
      return READONLY_RULES;
  }
}

/** The built-in agent definition backing each composer mode. */
function agentForMode(mode: ChatMode): AgentDefinition {
  switch (mode) {
    case "plan":
      return PLAN_AGENT;
    case "ask":
      return ASK_AGENT;
    case "delivery":
      return DELIVERY_AGENT;
    default:
      return BUILD_AGENT;
  }
}
