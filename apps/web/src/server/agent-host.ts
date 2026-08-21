import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AgentShell,
  ImageStore,
  SessionEventJournal,
  TerminalManager,
  createImageBridge,
  storeAttachedImages,
  type ImageModelChoice,
} from "@deyin/host-core";
import type { AgentEventEnvelope, AgentImageInput, AgentTodoItem, AgentUiEvent, ChatMode } from "@deyin/host-core/shared";
import {
  BUILTIN_SUBAGENTS,
  PermissionEngine,
  agentForMode,
  buildSystemPrompt,
  createRoleRouter,
  createTaskTool,
  expandCommand,
  matchCommand,
  modeReminder,
  rulesForApprovalMode,
  runAgent,
  runSubagent,
  skipPromptsForApproval,
  subagentReadonlyRules,
  type AgentEvent,
  type AgentMessage,
  type ImageGenBridge,
  type PermissionDecision,
  type PermissionEngineOptions,
  type SubagentDefinition,
  type ToolRegistry,
  type ToolSessionMeta,
} from "@deyin/agent-core";
import { PluginKernel } from "@deyin/kernel";
import { bundleBase, registerBasePlugins } from "@deyin/bundle-base";
import { createWebProfile } from "@deyin/bundle-web-app";
import { Capabilities, capsLocalPlugin } from "@deyin/plugin-caps-local";
import { buildToolRegistry, Tools } from "@deyin/tools";
import type { WebAgentProviderRouting } from "@deyin/contract/web";

/** Mirrors the desktop's prompt bridge timeout: unanswered prompts deny after 5 minutes. */
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

export interface WebAgentStartOptions {
  threadId: string;
  prompt: string;
  model: string;
  thinking: boolean;
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
}

interface ActiveRun {
  abort: AbortController;
  doneEmitted: boolean;
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
  private pendingPermissions = new Map<string, PendingPrompt<PermissionDecision>>();
  private pendingQuestions = new Map<string, PendingPrompt<Record<string, string | string[]>>>();
  /** Per-session plugin kernel: base bundle + sandbox-scoped capabilities. */
  private kernelPromise: Promise<PluginKernel> | null = null;
  /** Append-only event journal inside the sandbox (session-event-log spine). */
  private readonly journal: SessionEventJournal;

  constructor(
    private readonly root: string,
    private readonly terminals: TerminalManager,
    private readonly send: (envelope: AgentEventEnvelope) => void,
    private readonly emitTerminal: (msg: { type: "term.data"; termId: string; data: string } | { type: "term.exit"; termId: string; exitCode: number }) => void,
    /** Live repo branch info (null until a repository is connected). */
    private readonly repoInfo: () => { branch: string; defaultBranch: string } | null = () => null,
    /** Sandbox-scoped store for images the agent generates. */
    private readonly images?: ImageStore,
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

  start(options: WebAgentStartOptions): void {
    void this.startRun(options).catch((err) => {
      this.emit(options.threadId, { type: "error", message: err instanceof Error ? err.message : String(err) });
      this.finish(options.threadId, "aborted", "");
    });
  }

  stop(threadId: string): void {
    const run = this.active.get(threadId);
    if (run) run.abort.abort();
    this.denyPending(threadId);
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
    void this.kernelPromise?.then((kernel) => kernel.dispose());
    this.kernelPromise = null;
  }

  private emit(threadId: string, event: AgentUiEvent): void {
    this.send({ threadId, event });
    // Journal first, send after: an append failure must never drop the live
    // event, so failures are swallowed (the journal is a durable shadow).
    void this.journal.append(threadId, event).catch(() => undefined);
  }

  private finish(threadId: string, reason: "completed" | "max-steps" | "aborted", finalText: string): void {
    const run = this.active.get(threadId);
    if (!run || run.doneEmitted) return;
    run.doneEmitted = true;
    this.emit(threadId, { type: "done", reason, finalText });
  }

  private denyPending(threadId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.threadId !== threadId) continue;
      clearTimeout(pending.timer);
      this.pendingPermissions.delete(requestId);
      pending.resolve("deny");
    }
    for (const [requestId, pending] of this.pendingQuestions) {
      if (pending.threadId !== threadId) continue;
      clearTimeout(pending.timer);
      this.pendingQuestions.delete(requestId);
      pending.resolve({ __cancelled: "Run stopped before answers were returned." });
    }
  }

  private async startRun(options: WebAgentStartOptions): Promise<void> {
    this.stop(options.threadId);
    const state: ActiveRun = { abort: new AbortController(), doneEmitted: false };
    this.active.set(options.threadId, state);

    const kernel = await this.ensureKernel();
    const caps = kernel.get(Capabilities).snapshot();
    // Slash-command / skill expansion against the sandbox's own capabilities
    // (same contract as the desktop host).
    let prompt = options.prompt;
    const invocation = matchCommand(prompt);
    if (invocation) {
      const command = caps?.commands.find((c) => c.name === invocation.name);
      const skill = caps?.skills.find((s) => s.name === invocation.name);
      if (command) prompt = expandCommand(command, invocation.args);
      else if (skill) {
        prompt = `Read the skill file at ${skill.path} with the read tool and follow it for this task: ${invocation.args || "(no extra arguments)"}`;
      }
    }
    // Sandbox-defined subagents join the built-in set for the task tool.
    const subagents: SubagentDefinition[] = [...BUILTIN_SUBAGENTS, ...(caps?.subagents ?? [])];

    // Live per-run session state: mode tools mutate it so permissions, the
    // system prompt and the UI follow mid-run mode switches (same contract as
    // the desktop host).
    const sessionMeta: ToolSessionMeta = { threadId: options.threadId, mode: options.mode };
    const buildPermissions = (mode: ChatMode): PermissionEngineOptions => ({
      agentRules: rulesForApprovalMode(options.approvalMode),
      configRules: agentForMode(mode).permissions ?? [],
      skipAll: skipPromptsForApproval(options.approvalMode, mode),
    });
    const permissions = new PermissionEngine(buildPermissions(options.mode));

    const registry = await this.buildRegistry(options, subagents);
    // Attached pictures also land in the session image store, so generate_image
    // can edit them by file name instead of drawing something new.
    const attachedImages =
      options.images?.length && this.images
        ? storeAttachedImages(this.images, options.threadId, options.images)
        : { files: [], note: "" };
    const buildPrompt = (mode: ChatMode): string => {
      let prompt = buildSystemPrompt({ cwd: this.root, agent: agentForMode(mode), toolNames: registry.names() });
      const repo = this.repoInfo();
      if (repo) {
        prompt += `\n\n## Git workflow\nYou are working on branch "${repo.branch}" off "${repo.defaultBranch}". Commit your work to this branch as you go. Never push, merge, or open pull requests — the user ships changes with the Ship button.`;
      }
      return prompt;
    };
    // Hoisted so onModeChange can swap the system prompt and append reminders.
    const messages: AgentMessage[] = [
      { role: "system", content: buildPrompt(options.mode) },
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
    });

    const result = await runAgent({
      apiBaseUrl: options.provider.baseUrl,
      getToken: async () => options.provider.token,
      apiFormat: options.provider.apiFormat,
      authHeader: options.provider.authHeader,
      model: options.model,
      router,
      thinking: options.thinking,
      messages,
      tools: registry,
      permissions,
      todos: options.initialTodos ? options.initialTodos.map((t) => ({ ...t })) : [],
      resolvePermission: (req) => this.askPermission(options.threadId, req.toolName, req.summary),
      cwd: this.root,
      maxSteps: 40,
      signal: state.abort.signal,
      shell: await this.ensureShell(options.threadId),
      onEvent: (event) => this.forwardEvent(options.threadId, event),
      imageOutput: (options.imageChatModels ?? []).includes(options.model),
      toolContext: {
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
          messages[0] = { role: "system", content: buildPrompt(nextMode) };
          this.emit(options.threadId, { type: "mode-changed", mode: nextMode, previousMode: previous, reminder });

          if (change.event === "exit" && change.previous === "plan") {
            return change.userApproved
              ? "Plan mode exited. The user approved the plan — proceed with implementation."
              : "Plan mode exited. The plan has been presented to the user for approval.";
          }
          return `Switched to ${nextMode} mode.${change.explanation ? ` ${change.explanation}` : ""}`;
        },
      },
    });

    if (!state.doneEmitted) {
      state.doneEmitted = true;
      this.emit(options.threadId, { type: "done", reason: result.reason, finalText: result.finalText });
    }
  }

  /** Kernel tool catalog + the task tool over built-in and sandbox subagents. */
  private async buildRegistry(options: WebAgentStartOptions, subagents: SubagentDefinition[]): Promise<ToolRegistry> {
    const kernel = await this.ensureKernel();
    const registry = buildToolRegistry(kernel.get(Tools));
    // No image model in the client's catalog: drop generate_image rather than
    // advertising a tool whose every call would fail.
    if (!this.images || imageModelChoices(options).length === 0) registry.unregister("generate_image");
    registry.register(
      createTaskTool({
        subagents,
        runSubagent: (def: SubagentDefinition, prompt: string, signal?: AbortSignal) =>
          this.runSubagentTask(options, def, prompt, signal),
      }),
    );
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
    const store = this.images;
    if (!store) return undefined;
    return createImageBridge({
      store,
      threadId: options.threadId,
      apiBaseUrl: options.provider.baseUrl,
      getToken: async () => options.provider.token,
      models: () => imageModelChoices(options),
      // Generated pictures may be saved into the session sandbox on request.
      cwd: this.root,
      signal,
    });
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
  private forwardEvent(threadId: string, event: AgentEvent): void {
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
          result: event.result,
          ok: event.ok,
          denied: event.denied,
          cwd: event.cwd,
        });
        break;
      case "todos":
        this.emit(threadId, { type: "todos", todos: event.todos });
        break;
      case "usage":
        this.emit(threadId, { type: "usage", totalTokens: event.usage.totalTokens });
        break;
      case "context-snapshot":
        this.emit(threadId, { type: "context-snapshot", snapshot: event.snapshot });
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
