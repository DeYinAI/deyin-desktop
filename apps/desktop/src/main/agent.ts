import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserWindow, app } from "electron";
import type { AgentsStore, SettingsStore } from "@deyin/host-core";
import {
  ASK_AGENT,
  BUILD_AGENT,
  PLAN_AGENT,
  PermissionEngine,
  SessionStore,
  ToolRegistry,
  buildSystemPrompt,
  connectMcpDefinitions,
  createBuiltinRegistry,
  createCodebaseSearchTool,
  createTaskTool,
  expandCommand,
  loadContextFiles,
  matchCommand,
  runAgent,
  runHooks,
  type AgentDefinition,
  type AgentMessage,
  type LoadedHook,
  type McpConnection,
  type PermissionDecision,
  type PermissionRule,
  type SubagentDefinition,
} from "@deyin/agent-core";
import type { AgentEventEnvelope, AgentStartOptions, AgentUiEvent, ApprovalMode, ChatMode, IndexSearchHit } from "../shared/types.js";
import { CH } from "../shared/ipc.js";
import type { DeyinConfig } from "../shared/config.js";
import type { AuthManager } from "./auth.js";
import type { BrowserControlService } from "./browser.js";
import type { CapabilityService } from "./capabilities.js";

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
/** Files bigger than this ship to the renderer without diff content. */
const FILE_DIFF_CAP = 400_000;
const READONLY_RULES: PermissionRule[] = [
  { tool: "*", action: "deny" },
  { tool: "read", action: "allow" },
  { tool: "grep", action: "allow" },
  { tool: "glob", action: "allow" },
  { tool: "ls", action: "allow" },
  { tool: "websearch", action: "allow" },
  { tool: "todo_write", action: "allow" },
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
}

interface ActiveRun {
  abort: AbortController;
}

export interface AgentHostOptions {
  config: DeyinConfig;
  auth: AuthManager;
  agents: AgentsStore;
  settings: SettingsStore;
  capabilities: CapabilityService;
  browser: BrowserControlService;
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
    { resolve: (decision: PermissionDecision) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly store: SessionStore;

  constructor(private readonly opts: AgentHostOptions) {
    this.store = new SessionStore(join(app.getPath("userData"), "sessions"));
  }

  private send(threadId: string, event: AgentUiEvent): void {
    const envelope: AgentEventEnvelope = { threadId, event };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CH.agentEvent, envelope);
    }
  }

  isRunning(threadId: string): boolean {
    return this.active.has(threadId);
  }

  stop(threadId: string): void {
    this.active.get(threadId)?.abort.abort();
  }

  approve(requestId: string, decision: PermissionDecision): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
  }

  async start(options: AgentStartOptions): Promise<void> {
    if (this.active.has(options.threadId)) {
      this.send(options.threadId, { type: "error", message: "A run is already in progress for this task." });
      return;
    }
    const abort = new AbortController();
    this.active.set(options.threadId, { abort });
    try {
      await this.run(options, abort.signal);
    } catch (err) {
      this.send(options.threadId, { type: "error", message: err instanceof Error ? err.message : String(err) });
      this.send(options.threadId, { type: "done", reason: "aborted", finalText: "" });
    } finally {
      this.active.delete(options.threadId);
    }
  }

  private async run(options: AgentStartOptions, signal: AbortSignal): Promise<void> {
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
      agentRules: rulesForMode(options.approvalMode),
      configRules: modeAgent.permissions ?? [],
      skipAll: options.approvalMode === "full-access" && options.mode === "agent",
    });

    try {
      const result = await runAgent({
        apiBaseUrl,
        getToken,
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
        afterTool: async (call, result, ok) => {
          await runHooks(hooks, "postToolUse", call.name, { tool: call.name, ok, resultChars: result.length, cwd });
          if (call.name === "bash") {
            await runHooks(hooks, "afterShellExecution", call.name, { ok, cwd });
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
            case "tool-end":
              this.send(options.threadId, {
                type: "tool-end",
                callId: event.call.id,
                name: event.call.name,
                summary: "",
                result: event.result.length > 8_000 ? `${event.result.slice(0, 8_000)}\n… (truncated)` : event.result,
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
          }
        },
      });

      await runHooks(hooks, "stop", "stop", { reason: result.reason, cwd });
      this.send(options.threadId, { type: "done", reason: result.reason, finalText: result.finalText });
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
        resolvePermission: (req) => this.askPermission(parent.threadId, `${def.name} → ${req.toolName}`, req.summary),
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
    skills: Parameters<typeof buildSystemPrompt>[0]["skills"],
    hooks: LoadedHook[],
  ): Promise<ThreadSession> {
    const existing = this.sessions.get(options.threadId);
    if (existing) {
      // Mode switched mid-thread (e.g. plan -> agent via Build): rebuild the
      // system prompt in place — it is always messages[0].
      if (existing.mode !== options.mode) {
        existing.messages[0] = {
          role: "system",
          content: await this.systemPrompt(options.mode, cwd, registry, skills, hooks),
        };
        existing.mode = options.mode;
      }
      return existing;
    }

    const system = await this.systemPrompt(options.mode, cwd, registry, skills, hooks);
    const messages: AgentMessage[] = [{ role: "system", content: system }];
    // Rebuild prior plain-text turns (post-restart continuity).
    for (const turn of options.history) {
      messages.push({ role: turn.role, content: turn.content });
    }

    const meta = this.store.create({ cwd, model: options.model, agent: agentForMode(options.mode).name });
    for (const message of messages) this.store.append(meta.id, message);
    const session: ThreadSession = { sessionId: meta.id, messages, mode: options.mode };
    this.sessions.set(options.threadId, session);
    this.threadToSession.set(options.threadId, meta.id);
    return session;
  }

  private async systemPrompt(
    mode: ChatMode,
    cwd: string,
    registry: ToolRegistry,
    skills: Parameters<typeof buildSystemPrompt>[0]["skills"],
    hooks: LoadedHook[],
  ): Promise<string> {
    const agent = agentForMode(mode);
    const contextFiles = await loadContextFiles(cwd).catch(() => []);
    let system = buildSystemPrompt({
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

    // sessionStart hooks can contribute extra context.
    const startHooks = await runHooks(hooks, "sessionStart", "sessionStart", { cwd });
    if (startHooks.additionalContext && startHooks.additionalContext.length > 0) {
      system += `\n\n# Hook context\n${startHooks.additionalContext.join("\n")}`;
    }
    return system;
  }

  private askPermission(threadId: string, toolName: string, summary: string): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        resolve("deny");
      }, PERMISSION_TIMEOUT_MS);
      this.pendingPermissions.set(requestId, { resolve, timer });
      this.send(threadId, { type: "permission-request", requestId, toolName, summary });
    });
  }
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
    default:
      return BUILD_AGENT;
  }
}
