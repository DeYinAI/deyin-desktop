import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, app } from "electron";
import { AgentShell, ShellUnavailableError, type AgentsStore, type MemoryStore, type SettingsStore, type TerminalManager } from "@deyin/host-core";
import {
  PermissionEngine,
  SessionStore,
  ToolRegistry,
  appendHookContext,
  buildSystemPromptParts,
  connectMcpDefinitions,
  createBuiltinRegistry,
  createCodebaseSearchTool,
  createTaskTool,
  estimateContextUsage,
  expandCommand,
  loadContextFiles,
  matchCommand,
  runAgent,
  runHooks,
  Semaphore,
  agentForMode,
  rulesForApprovalMode,
  runSubagent,
  subagentReadonlyRules,
  type AgentMessage,
  type InteractionRequest,
  type LoadedHook,
  type ModeChangeRequest,
  type McpConnection,
  type PermissionDecision,
  type PlanArtifact,
  type SubagentDefinition,
  subagentEffort,
  type SystemPromptSections,
  type ToolSessionMeta,
  type ToolShell,
} from "@deyin/agent-core";
import {
  bindAgentCacheHooks,
  createOptimizationPlugin,
  type OptimizationPlugin,
} from "@deyin/optimization-plugin";
import type { ProviderApiFormat } from "@deyin/agent-core";
import type { AgentEventEnvelope, AgentStartOptions, AgentUiEvent, ChatMode, IndexSearchHit } from "../shared/types.js";
import { truncateToolResultUi } from "../shared/types.js";
import { CH } from "../shared/ipc.js";
import type { DeyinConfig } from "../shared/config.js";
import type { AuthManager } from "./auth.js";
import type { BrowserControlService } from "./browser.js";
import type { CapabilityService } from "./capabilities.js";

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
/** Files bigger than this ship to the renderer without diff content. */
const FILE_DIFF_CAP = 400_000;

/** Short stable hash for response-cache keying (model|mode|system prompt). */
function shortHash(text: string): string {
 return createHash("sha256").update(text).digest("hex").slice(0, 16);
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
  terminals: TerminalManager;
  /** Background memory store (remember/forget tools + recall). */
  memory: MemoryStore;
  getWorkspaceRoot: () => string | null;
  searchIndex: (query: string, topK: number) => Promise<IndexSearchHit[]>;
  /** Context window for the model, when known (drives compaction). */
  getContextLength: (providerId: string, modelId: string) => number | undefined;
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
    { threadId: string; resolve: (decision: PermissionDecision) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly pendingQuestions = new Map<
    string,
    { threadId: string; resolve: (answers: string) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly agentInbox = new Map<string, string[]>();
  private readonly backgroundTasks = new Map<string, Promise<{ output: string; exitCode: number | null }>>();
  private readonly store: SessionStore;
  /** Caps how many task-tool subagent runs execute in parallel (settings.subagentConcurrency). */
  private readonly subagentLimiter = new Semaphore(() => this.opts.settings.get().subagentConcurrency);
  private optimizationPlugin: OptimizationPlugin | null = null;
  private optimizationPluginLoading: Promise<OptimizationPlugin | null> | null = null;
  private optimizationPluginLoadError: string | null = null;
  private optimizationPluginLoadErrorNotified = false;

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

  async start(options: AgentStartOptions): Promise<void> {
    if (this.active.has(options.threadId)) {
      this.send(options.threadId, { type: "error", message: "A run is already in progress for this task." });
      return;
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
    if (settings.browserControlEnabled && caps.browserEnabled) {
      for (const tool of this.opts.browser.tools()) registry.register(tool);
    }
    const subagents = caps.subagents;
    if (subagents.length > 0) {
      registry.register(
        createTaskTool({
          subagents,
          runSubagent: (def, subPrompt, subSignal) =>
            this.runSubagent(options, def, subPrompt, apiBaseUrl, getToken, subSignal),
          onBackgroundDone: (def, result) => {
            this.send(options.threadId, { type: "subagent-end", name: def.name, ok: result.ok });
          },
        }),
      );
    }
    const mcpConnections: McpConnection[] = await connectMcpDefinitions(
      caps.mcpServers.map((def) => this.opts.capabilities.resolvePluginVariables(def)),
      registry,
      { onError: () => undefined },
    );

    // Hooks (custom only, from hooks.json files).
    const hooks = caps.hooks;

    // Transcript: reuse the in-memory session, else restore/create a persisted one.
    const session = await this.ensureSession(options, cwd, registry, caps.skills.length > 0 ? caps.skills : [], hooks);
    session.messages.push({ role: "user", content: prompt });
    this.store.append(session.sessionId, { role: "user", content: prompt });

    // Two independent axes: the access level (approvalMode chip) provides the base
    // rules; the composer mode's own restrictions come last so plan/ask stay
    // read-only even under "full access". skipAll only ever applies to agent mode.
    const modeAgent = agentForMode(options.mode);
    const permissions = new PermissionEngine({
      agentRules: rulesForApprovalMode(options.approvalMode),
      configRules: modeAgent.permissions ?? [],
      skipAll: options.approvalMode === "full-access" && options.mode === "agent",
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

      const result = await runAgent({
        apiBaseUrl,
        getToken,
        apiFormat: provider?.apiFormat ?? "chat-completions",
        authHeader: provider?.authHeader,
        model: options.model,
        contextLength: this.opts.getContextLength(options.providerId, options.model),
        messages: session.messages,
        tools: registry,
        permissions,
        resolvePermission: (req) => this.askPermission(options.threadId, req.toolName, req.summary),
        cwd,
        thinking: options.thinking,
        signal,
        todos: options.initialTodos ? options.initialTodos.map((t) => ({ ...t })) : [],
        shell: shellBridge,
        systemSections: session.systemSections,
        memory: settings.memoryEnabled ? this.opts.memory : undefined,
        toolContext: {
          skills: caps.skills.map((s) => ({ name: s.name, path: s.path, description: s.description })),
          sessionMeta: liveMeta,
          memory: settings.memoryEnabled ? this.opts.memory : undefined,
          resolveInteraction: (request) => this.resolveInteraction(options.threadId, request),
          onPlanCreated: (plan) => this.onPlanCreated(options.threadId, plan),
          onModeChange: async (change) => {
            const result = await this.handleModeChange(
              options.threadId,
              session,
              options,
              change,
              cwd,
              registry,
              caps.skills,
              hooks,
            );
            liveMeta.mode = session.mode;
            return result;
          },
          sendMessage: async (to, content) => {
            const key = `${options.threadId}:${to}`;
            const list = this.agentInbox.get(key) ?? [];
            list.push(content);
            this.agentInbox.set(key, list);
            return `Message delivered to ${to}.`;
          },
          pollBackgroundTask: (taskId, blockUntilMs) => this.pollBackgroundTask(taskId, blockUntilMs),
          registerBackgroundTask: (taskId, promise) => {
            this.backgroundTasks.set(taskId, promise);
            void promise.finally(() => this.backgroundTasks.delete(taskId));
          },
        },
        wire: {
          enableCompression: settings.optimizationCompression,
          compressionMode: settings.optimizationCompressionMode,
          enablePromptCaching: settings.optimizationPromptCaching,
          provider: provider?.kind === "custom" ? "openai" : "openference",
        },
        promptCacheKey: `deyin:${options.providerId}:${options.model}:${cwd}`,
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
case "usage":
 this.send(options.threadId, { type: "usage", totalTokens: event.usage.totalTokens });
 break;
 case "context-snapshot":
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
 });
 break;
          }
        },
      });

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

  /** Fresh, clean-context run for the Task tool, gated by the concurrency cap. */
  private async runSubagent(
    parent: AgentStartOptions,
    def: SubagentDefinition,
    prompt: string,
    apiBaseUrl: string,
    getToken: () => Promise<string | null>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; report: string }> {
    return this.subagentLimiter.run(() => this.runSubagentUncapped(parent, def, prompt, apiBaseUrl, getToken, signal));
  }

  private async runSubagentUncapped(
    parent: AgentStartOptions,
    def: SubagentDefinition,
    prompt: string,
    apiBaseUrl: string,
    getToken: () => Promise<string | null>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; report: string }> {
    this.send(parent.threadId, { type: "subagent-start", name: def.name, prompt: prompt.slice(0, 200) });
    const cwd = this.opts.getWorkspaceRoot() ?? process.cwd();
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
      resolveProvider: (providerId) => {
        const provider = this.opts.agents.listProviders(true).find((p) => p.id === providerId);
        if (provider && provider.kind === "custom") {
          return {
            apiBaseUrl: provider.baseUrl ?? this.opts.config.apiBaseUrl,
            getToken: () => Promise.resolve(this.opts.agents.getKey(provider.id)),
            apiFormat: provider.apiFormat ?? "chat-completions",
            authHeader: provider.authHeader,
          };
        }
        return {
          apiBaseUrl: this.opts.config.apiBaseUrl,
          getToken: () => this.opts.auth.getAccessToken(),
          apiFormat: parentProviderWire.apiFormat,
          authHeader: parentProviderWire.authHeader,
        };
      },
      // Subagents inherit the parent run's mode restrictions: a plan/ask session
      // must stay read-only even inside a spawned task.
      permissionEngine: new PermissionEngine({
        agentRules: rulesForApprovalMode(parent.approvalMode),
        configRules: [...(agentForMode(parent.mode).permissions ?? []), ...subagentReadonlyRules(def)],
        skipAll: parent.approvalMode === "full-access" && parent.mode === "agent" && !def.readonly,
      }),
      resolvePermission: (req) => this.askPermission(parent.threadId, `${def.name} → ${req.toolName}`, req.summary),
      extraTools: this.opts.settings.get().indexingEnabled
        ? [createCodebaseSearchTool((query, topK) => this.opts.searchIndex(query, topK))]
        : [],
      signal,
    });
    this.send(parent.threadId, { type: "subagent-end", name: def.name, ok: result.ok });
    return result;
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
  ): Promise<string> {
    const previous = session.mode;
    if (change.event === "enter" && change.target === "plan") {
      session.previousMode = previous;
    }
    const nextMode = change.target;
    session.mode = nextMode;
    options.mode = nextMode;

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
        return "You have entered plan mode. You MUST NOT modify the workspace. Use read/grep/glob/ls to gather evidence. If the request is ambiguous, use ask_question to clarify. Then call todo_write with implementation steps and create_plan or output your final plan as markdown.";
      case "ask":
        return "You are in ask mode. Answer questions and explore the codebase. You MUST NOT modify the workspace or run commands.";
      case "agent":
        return "You are in agent mode. Implement the user's request end to end using all available tools.";
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
