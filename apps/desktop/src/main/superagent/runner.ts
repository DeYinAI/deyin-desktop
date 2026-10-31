import {
  AuthRequiredError,
  PermissionEngine,
  ProviderHttpError,
  ToolRegistry,
  runAgent,
  type AgentMessage,
  type AgentRunOptions,
  type AgentRunResult,
} from "@deyin/agent-core";
import { AgentRunError, blockedCommand, type AgentRunRequest, type AgentRunResult as RunnerResult, type AgentRunner, type Logger, type ModelRef } from "@deyin/superagent";
import { SessionHistory } from "./history.js";
import { COMMAND_TOOLS, WORKER_BUILTIN_TOOLS, toToolDefinition } from "./tools.js";

/** Told to every unattended conversation, after the role's own prompt. */
export const UNATTENDED_NOTE =
  "\n\nThis conversation runs unattended inside Deyin Desktop. No one can answer a question or approve a step while you work, so never ask for confirmation or wait for input; decide, act, and report through the orchestrator_* tools.";

/** Statuses from the model provider that a repeat cannot fix: a bad key, no access, an unknown model or endpoint. */
const PERMANENT_STATUSES = new Set([401, 402, 403, 404]);

export interface RunnerDeps {
  /** Where conversations are kept, one file each. */
  sessionsDir: string;
  logger: Logger;
  /** The app's default model, used when Superagent has none of its own; `null` when none is chosen. */
  defaultModel(): ModelRef | null;
  /** Where to send requests for a provider, and how to authenticate them. */
  route(providerId: string): { apiBaseUrl: string; getToken: () => Promise<string | null> };
  contextLength(providerId: string, model: string): number | undefined;
  /** The user's step limit (`null` is unlimited) and whether the model should reason. */
  options(): { maxSteps: number | null; thinking: boolean };
  /** The built-in tools to pick a worker's from. */
  builtinTools(): ToolRegistry;
  /** The agent loop; replaceable so the runner can be tested without a model. */
  run?: (options: AgentRunOptions) => Promise<AgentRunResult>;
  /** The directory a conversation without a working directory (the orchestrator) starts in. */
  homeDir: string;
  saveDebounceMs?: number;
}

/** The app's `providerId::modelId` setting as a model reference; a bare id belongs to the primary provider. */
export function parseModelId(value: string | null | undefined): ModelRef | null {
  const text = value?.trim();
  if (!text) return null;
  const at = text.indexOf("::");
  if (at < 0) return { providerId: "openference", model: text };
  const providerId = text.slice(0, at).trim();
  const model = text.slice(at + 2).trim();
  return providerId && model ? { providerId, model } : null;
}

function toRunnerError(error: unknown): Error {
  if (error instanceof AgentRunError) return error;
  if (error instanceof AuthRequiredError) return new AgentRunError("The model provider needs a sign-in or an API key (Settings → Providers)", false);
  if (error instanceof ProviderHttpError && PERMANENT_STATUSES.has(error.status)) {
    return new AgentRunError(`The model provider refused the request (${error.status}): ${error.message}`, false);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Runs Superagent's conversations on the desktop agent loop, keeping each one's history between runs. */
export class AgentCoreRunner implements AgentRunner {
  private readonly history: SessionHistory;

  constructor(private readonly deps: RunnerDeps) {
    this.history = new SessionHistory(deps.sessionsDir, deps.saveDebounceMs);
  }

  private model(request: AgentRunRequest): ModelRef {
    const model = request.model ?? this.deps.defaultModel();
    if (!model) throw new AgentRunError("No model is chosen: set one in the Superagent settings or pick a default model in Deyin", false);
    return model;
  }

  private registry(request: AgentRunRequest): ToolRegistry {
    const registry = request.role === "worker" ? this.deps.builtinTools().filtered(WORKER_BUILTIN_TOOLS) : new ToolRegistry();
    for (const tool of request.tools) registry.register(toToolDefinition(tool));
    return registry;
  }

  async run(request: AgentRunRequest): Promise<RunnerResult> {
    const model = this.model(request);
    const route = this.deps.route(model.providerId);
    const { maxSteps, thinking } = this.deps.options();
    const run = this.deps.run ?? runAgent;
    const registry = this.registry(request);
    const cwd = request.cwd ?? this.deps.homeDir;
    const messages: AgentMessage[] = [{ role: "system", content: request.systemPrompt + UNATTENDED_NOTE }, ...this.history.load(request.sessionId)];
    const push = (texts: readonly string[]): void => {
      for (const content of texts) messages.push({ role: "user", content });
    };
    push(request.messages);
    this.history.schedule(request.sessionId, () => messages);

    // No prompts: the tools a conversation has were chosen above, and computer use and browser navigation are not among them.
    const permissions = new PermissionEngine({ agentRules: [], configRules: [], skipAll: true });
    let finalText = "";
    try {
      for (;;) {
        const result = await run({
          apiBaseUrl: route.apiBaseUrl,
          getToken: route.getToken,
          model: model.model,
          maxSteps,
          contextLength: this.deps.contextLength(model.providerId, model.model),
          messages,
          tools: registry,
          permissions,
          resolvePermission: async () => "allow",
          cwd,
          thinking,
          signal: request.signal,
          // These runs have no todo list to reconcile and no compiler to ask; both would only add turns.
          todoReconcile: false,
          diagnosticLoopback: false,
          toolContext: { env: request.env },
          drainPendingMessages: () => request.drain().map((content): AgentMessage => ({ role: "user", content })),
          onMessage: () => this.history.schedule(request.sessionId, () => messages),
          beforeTool: async (call, args) => {
            if (!COMMAND_TOOLS.includes(call.name)) return undefined;
            const command = typeof args.command === "string" ? args.command : "";
            const blocked = blockedCommand(command, request.blockedCommands);
            return blocked ? { block: `The command "${blocked}" is blocked by the Superagent settings.` } : undefined;
          },
        });
        finalText = result.finalText;
        if (request.signal.aborted || result.reason === "aborted") break;
        if (result.reason === "max-steps") {
          throw new AgentRunError(`Stopped at the step limit (${maxSteps ?? "none"}); raise "Step limit" in Settings, then retry`, false);
        }
        // A message that arrived as the model finished is a new turn, not a lost one.
        const more = request.drain();
        if (more.length === 0) break;
        push(more);
      }
    } catch (error) {
      if (request.signal.aborted) return { finalText };
      throw toRunnerError(error);
    } finally {
      this.history.save(request.sessionId, messages);
    }
    return { finalText };
  }

  async forget(sessionId: string): Promise<void> {
    this.history.forget(sessionId);
  }

  /** Writes every conversation still waiting to be saved; called as the app quits. */
  flush(): void {
    this.history.flushAll();
  }
}
