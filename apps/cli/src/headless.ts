import {
  AuthRequiredError,
  PermissionEngine,
  autoSelectAskQuestionAnswers,
  buildSystemPrompt,
  connectMcpServers,
  createBuiltinRegistry,
  createRoleRouter,
  estimateTokens,
  loadContextFiles,
  resolveAgent,
  runAgent,
  BUILD_AGENT,
  type AgentEvent,
  type AgentMessage,
  type McpConnection,
} from "@deyin/agent-core";
import { buildPromptCacheKeyFor, resolveWireProvider } from "@deyin/host-core/shared";
import type { CliContext } from "./context.js";
import { tokenSource } from "./context.js";
import { dim, red } from "./output.js";
import { registerCliSubagentTool } from "./subagents.js";

export interface HeadlessOptions {
  ctx: CliContext;
  prompt: string;
  /** NDJSON events on stdout instead of plain text. */
  json?: boolean;
  /** --yes: skip all permission prompts (everything allowed). */
  yes?: boolean;
  /** Continue the most recent session for this workspace. */
  continueLast?: boolean;
  /** Resume a specific session id. */
  resumeId?: string;
  maxSteps?: number;
  signal?: AbortSignal;
  /** Injectable for tests. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  getToken?: () => Promise<string | null>;
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_AUTH = 2;
export const EXIT_INTERRUPT = 130;

/**
 * Non-interactive agent run for scripting/CI: prints the assistant's text to stdout
 * (or NDJSON events with --json), tool activity to stderr, and returns an exit code.
 * "ask" permissions are auto-denied unless --yes is set.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const { ctx } = opts;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const getToken = opts.getToken ?? tokenSource(ctx);

  if ((await getToken()) === null) {
    stderr.write(`${red("error:")} not signed in. Run \`deyin login\` first.\n`);
    return EXIT_AUTH;
  }

  const agent = resolveAgent(ctx.config, ctx.config.agent) ?? BUILD_AGENT;
  const tools = createBuiltinRegistry();
  // The CLI has no image store or picker, so nothing can render a generated
  // picture: drop the tool rather than let the model promise one.
  tools.unregister("generate_image");
  await registerCliSubagentTool(tools, {
    ctx,
    skipAll: opts.yes ?? false,
    resolvePermission: async (req) => {
      stderr.write(dim(`[permission] auto-denied ${req.toolName} (${req.summary}); pass --yes to allow\n`));
      return "deny";
    },
    onBackgroundDone: (def) => stderr.write(dim(`[subagent] background \u201c${def.name}\u201d finished\n`)),
  });
  const mcp: McpConnection[] = await connectMcpServers(ctx.config.mcpServers, tools, {
    onError: (server, err) =>
      stderr.write(dim(`[mcp] ${server}: failed to start (${err instanceof Error ? err.message : String(err)})\n`)),
  });

  // Session: resume/continue an existing transcript, or start a fresh one.
  let sessionId: string;
  let messages: AgentMessage[];
  let newSession = false;
  if (opts.resumeId || opts.continueLast) {
    const meta = opts.resumeId
      ? ctx.sessions.load(opts.resumeId)?.meta
      : (ctx.sessions.latest(ctx.cwd) ?? undefined);
    const loaded = meta ? ctx.sessions.load(meta.id) : null;
    if (!loaded) {
      stderr.write(`${red("error:")} session not found.\n`);
      return EXIT_ERROR;
    }
    sessionId = loaded.meta.id;
    messages = loaded.messages;
  } else {
    newSession = true;
    const meta = ctx.sessions.create({ cwd: ctx.cwd, model: ctx.config.model, agent: agent.name });
    sessionId = meta.id;
    const contextFiles = await loadContextFiles(ctx.cwd);
    const system: AgentMessage = {
      role: "system",
      content: buildSystemPrompt({ cwd: ctx.cwd, agent, toolNames: tools.names(), contextFiles }),
    };
    messages = [system];
    ctx.sessions.append(sessionId, system);
  }

  const userMessage: AgentMessage = { role: "user", content: opts.prompt };
  messages.push(userMessage);
  ctx.sessions.append(sessionId, userMessage);

  const permissions = new PermissionEngine({
    agentRules: agent.permissions,
    configRules: ctx.config.permissions,
    skipAll: opts.yes ?? false,
  });

  const emitJson = (event: AgentEvent | { type: "result"; [k: string]: unknown }): void => {
    stdout.write(`${JSON.stringify(event)}\n`);
  };

  const toolStartedAt = new Map<string, number>();
  const onEvent = (event: AgentEvent): void => {
    if (opts.json) {
      emitJson(event);
      return;
    }
    switch (event.type) {
      case "text-delta":
        stdout.write(event.delta);
        break;
      case "tool-start":
        toolStartedAt.set(event.call.id, Date.now());
        stderr.write(dim(`[tool] ${event.call.name}: ${event.summary}\n`));
        break;
      case "tool-end": {
        const elapsed = ((Date.now() - (toolStartedAt.get(event.call.id) ?? Date.now())) / 1000).toFixed(1);
        const status = event.denied ? "denied" : event.ok ? "done" : "error";
        stderr.write(dim(`[tool] ${event.call.name}: ${status} (${elapsed}s)\n`));
        break;
      }
      case "compaction":
        stderr.write(dim(`[context] compacted (${event.droppedMessages} messages dropped)\n`));
        break;
      default:
        break;
    }
  };

  const before = messages.length;
  try {
    const result = await runAgent({
      apiBaseUrl: ctx.config.apiBaseUrl,
      getToken,
      model: ctx.config.model,
      // Per-phase model routing. The CLI talks to one endpoint, so a role's
      // "providerId::" prefix (if any) is ignored and only the model swaps.
      router: createRoleRouter({
        roleModels: ctx.config.roleModels,
        base: {
          model: ctx.config.model,
          providerId: "cli",
          apiBaseUrl: ctx.config.apiBaseUrl,
          getToken,
        },
      }),
      messages,
      tools,
      permissions,
      resolvePermission: async (req) => {
        stderr.write(dim(`[permission] auto-denied ${req.toolName} (${req.summary}); pass --yes to allow\n`));
        return "deny";
      },
      toolContext: {
        // The configured agent doubles as the composer mode, so role routing
        // picks the plan/ask/delivery model when running under those agents.
        sessionMeta: { mode: agent.name, model: ctx.config.model, cwd: ctx.cwd },
        resolveInteraction: async (request) => {
          if (request.type !== "ask-question") return "Interaction not supported.";
          if (opts.yes) {
            return JSON.stringify(autoSelectAskQuestionAnswers(request), null, 2);
          }
          stderr.write(dim("[ask_question] no TTY interaction in headless mode; auto-selecting first options\n"));
          return JSON.stringify(autoSelectAskQuestionAnswers(request), null, 2);
        },
        memory: ctx.config.memoryEnabled ? ctx.memory : undefined,
      },
      memory: ctx.config.memoryEnabled ? ctx.memory : undefined,
      onEvent,
      onMessage: (message) => ctx.sessions.append(sessionId, message),
      cwd: ctx.cwd,
      thinking: ctx.config.thinking,
      maxSteps: opts.maxSteps ?? ctx.config.maxSteps,
      signal: opts.signal,
      // Cache parity with desktop: compression + prompt caching + stable key.
      wire: {
        enableCompression: true,
        compressionMode: "balanced",
        enablePromptCaching: true,
        provider: resolveWireProvider({
          providerId: "cli",
          model: ctx.config.model,
          cwd: ctx.cwd,
          apiFormat: "chat-completions",
        }),
        model: ctx.config.model,
      },
      promptCacheKey: buildPromptCacheKeyFor({
        providerId: "cli",
        model: ctx.config.model,
        cwd: ctx.cwd,
      }),
    });

    const tokens = result.usage.totalTokens || estimateTokens(messages.slice(before));
    ctx.usage.record({ model: ctx.config.model, tokens, newSession });

    if (opts.json) {
      emitJson({
        type: "result",
        reason: result.reason,
        steps: result.steps,
        usage: result.usage,
        sessionId,
        finalText: result.finalText,
      });
    } else {
      if (result.finalText && !result.finalText.endsWith("\n")) stdout.write("\n");
      if (result.reason === "max-steps") stderr.write(`${red("error:")} stopped after ${result.steps} steps (max-steps).\n`);
    }

    if (result.reason === "aborted") return EXIT_INTERRUPT;
    return result.reason === "completed" ? EXIT_OK : EXIT_ERROR;
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      stderr.write(`${red("error:")} ${err.message}\n`);
      return EXIT_AUTH;
    }
    stderr.write(`${red("error:")} ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_ERROR;
  } finally {
    await Promise.allSettled(mcp.map((c) => c.close()));
  }
}
