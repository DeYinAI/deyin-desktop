import {
  AuthRequiredError,
  BUILD_AGENT,
  PermissionEngine,
  buildSystemPrompt,
  compactWithModel,
  connectMcpDefinitions,
  createBuiltinRegistry,
  createRoleRouter,
  detectProjectToolchain,
  estimateTokens,
  executeShellCommand,
  getSessionJobsManager,
  loadContextFiles,
  applyGoalCommandText,
  matchCommand,
  repoMapTool,
  resolveAgent,
  resolveAgents,
  resolvePathInWorkspace,
  runHooks,
  runAgent,
  type AgentEvent,
  type AgentMessage,
  type CapabilitySnapshot,
  type ContextFile,
  type McpConnection,
  type PermissionDecision,
  type PermissionRequest,
  type InteractionRequest,
  type ProjectToolchainInfo,
  type TodoItem,
  type ToolRegistry,
} from "@deyin/agent-core";
import { CheckpointStore, checkpointFileOpsFromRoot, createImageBridge, ImageStore, listModels, revertCheckpoint, type ModelInfo } from "@deyin/host-core";
import { buildPromptCacheKeyFor, resolveWireProvider } from "@deyin/host-core/shared";
import { loginWithDevice } from "@deyin/oauth-client/node";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import type { CliContext } from "../context.js";
import { cliProviderRouting, createCliShell, resolveCliModel } from "../context.js";
import { cliMcpDefinitions, loadCliCapabilities, resolveCliPrompt } from "../capabilities.js";
import { runRemote } from "../remote.js";
import { registerCliSubagentTool } from "../subagents.js";
import { updateNotice } from "../version.js";
import { Composer } from "./Composer.js";
import { openInEditor } from "./editor.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { QuestionPrompt } from "./QuestionPrompt.js";
import { Picker, type PickerItem } from "./Picker.js";
import { messagesToItems, nextId, toolPreview, type TranscriptItem } from "./items.js";
import { renderMarkdown, tailLines } from "./markdown.js";

const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

const SLASH_COMMANDS: { name: string; description: string }[] = [
  { name: "/help", description: "Show available commands" },
  { name: "/undo", description: "Revert the last turn and file modifications" },
  { name: "/model", description: "Switch model" },
  { name: "/agent", description: "Switch agent (build/plan/custom)" },
  { name: "/editor", description: "Compose prompt in external $EDITOR (Ctrl+O)" },
  { name: "/map", description: "Generate symbol repo-map (/map [query])" },
  { name: "/new", description: "Start a fresh session" },
  { name: "/sessions", description: "Browse and resume sessions" },
  { name: "/compact", description: "Summarize the conversation to free context" },
  { name: "/usage", description: "Show usage statistics" },
  { name: "/memory", description: "List saved background memories" },
  { name: "/remember", description: "Save a note as a project memory (/remember <note>)" },
  { name: "/goal", description: "Set a verifiable task goal (/goal <objective>)" },
  { name: "/login", description: "Sign in with Openference (device flow)" },
  { name: "/exit", description: "Quit deyin" },
];

export interface AppInitialState {
  continueLast?: boolean;
  resumeId?: string;
  openSessionPicker?: boolean;
  trustWorkspace?: boolean;
  remote?: {
    url: string;
    token?: string;
    username?: string;
    password?: string;
    continueLast?: boolean;
    resumeId?: string;
    fork?: boolean;
  };
}

interface PermissionState {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
}

interface QuestionState {
  request: Extract<InteractionRequest, { type: "ask-question" }>;
  resolve: (answers: string) => void;
}

interface PickerState {
  kind: "model" | "agent" | "session";
  title: string;
  items: PickerItem[];
}

export function App({ ctx, initial }: { ctx: CliContext; initial: AppInitialState }): JSX.Element {
  const { exit } = useApp();

  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [streamText, setStreamText] = useState("");
  const [streamReasoning, setStreamReasoning] = useState("");
  const [activeTool, setActiveTool] = useState<{ name: string; summary: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [usageTokens, setUsageTokens] = useState(0);
  const initialModel = resolveCliModel(ctx);
  const [model, setModel] = useState(initialModel.model);
  const [agentName, setAgentName] = useState(ctx.config.agent);
  const [userLabel, setUserLabel] = useState<string | null>(null);
  const [updateLine, setUpdateLine] = useState<string | null>(null);
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [question, setQuestion] = useState<QuestionState | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [input, setInput] = useState("");
  const [exitArmed, setExitArmed] = useState(false);
  const [modelList, setModelList] = useState<ModelInfo[]>([]);
  const [spin, setSpin] = useState(0);

  const messagesRef = useRef<AgentMessage[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const remoteSessionIdRef = useRef<string | null>(initial.remote?.resumeId ?? null);
  const remoteStartedRef = useRef(false);
  const newSessionRef = useRef(false);
  const toolsRef = useRef<ToolRegistry>(createBuiltinRegistry());
  const abortRef = useRef<AbortController | null>(null);
  const goalTextRef = useRef<string | undefined>(undefined);
  const historyRef = useRef<string[]>([]);
  const contextFilesRef = useRef<ContextFile[]>([]);
  const projectToolchainRef = useRef<ProjectToolchainInfo | null>(null);
  const capsRef = useRef<CapabilitySnapshot | null>(null);
  const mcpRef = useRef<McpConnection[]>([]);
  const shellRef = useRef<Awaited<ReturnType<typeof createCliShell>>>(undefined);
  const toolSummaryRef = useRef(new Map<string, string>());
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const permEngineRef = useRef(
    new PermissionEngine({
      agentRules: (resolveAgent(ctx.config, ctx.config.agent) ?? BUILD_AGENT).permissions,
      configRules: ctx.config.permissions,
    }),
  );

  const pushItem = useCallback((item: TranscriptItem) => setItems((prev) => [...prev, item]), []);
  const notice = useCallback(
    (text: string, tone: "info" | "warn" | "error" = "info") => pushItem({ kind: "notice", id: nextId(), text, tone }),
    [pushItem],
  );

  /** Route a permission request to the interactive prompt (shared by main + subagent runs). */
  const requestPermission = useCallback(
    (request: PermissionRequest) =>
      new Promise<PermissionDecision>((resolve) => {
        setPermission({
          request,
          resolve: (decision) => {
            setPermission(null);
            resolve(decision);
          },
        });
      }),
    [],
  );

  const agentDef = useCallback(
    (name = agentName) => resolveAgent(ctx.config, name) ?? BUILD_AGENT,
    [ctx.config, agentName],
  );

  const loadSession = useCallback(
    (id: string | undefined) => {
      if (!id) {
        notice("No session to resume.", "warn");
        return;
      }
      const loaded = ctx.sessions.load(id);
      if (!loaded) {
        notice(`Session ${id} not found.`, "warn");
        return;
      }
      messagesRef.current = loaded.messages;
      sessionIdRef.current = loaded.meta.id;
      newSessionRef.current = false;
      pushItem({ kind: "notice", id: nextId(), text: `\u2500\u2500 resumed ${loaded.meta.id}: ${loaded.meta.title} \u2500\u2500`, tone: "info" });
      setItems((prev) => [...prev, ...messagesToItems(loaded.messages)]);
    },
    [ctx.sessions, notice, pushItem],
  );

  // Startup: project context, MCP servers, auth state, model list, update check, resume.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [ctxFiles, toolchain] = await Promise.all([
        loadContextFiles(ctx.cwd),
        detectProjectToolchain(ctx.cwd).catch(() => null),
      ]);
      contextFilesRef.current = ctxFiles;
      projectToolchainRef.current = toolchain;
      capsRef.current = await loadCliCapabilities({
        cwd: ctx.cwd,
        dataDir: ctx.dataDir,
        trustedWorkspace: initial.trustWorkspace,
      });
      if (initial.remote) {
        if (!cancelled) notice(`Attached to ${initial.remote.url}. The remote server owns tools, providers, and the session.`);
      } else {
        const connections = await connectMcpDefinitions(cliMcpDefinitions(capsRef.current, ctx.config.mcpServers), toolsRef.current, {
          onError: (server, err) =>
            !cancelled && notice(`mcp ${server}: failed to start (${err instanceof Error ? err.message : String(err)})`, "warn"),
        });
        mcpRef.current = connections;
        await registerCliSubagentTool(toolsRef.current, {
          ctx,
          sessionId: () => sessionIdRef.current,
          skipAll: false,
          resolvePermission: requestPermission,
          onBackgroundDone: (_jobId, def) => notice(`Background subagent \u201c${def.name}\u201d finished`, "info"),
        });
        if (!cancelled) {
          for (const c of connections) notice(`mcp ${c.name}: ${c.toolCount} tool(s) connected`);
        }
        try {
          if (await ctx.oauth.isAuthenticated()) {
            const user = await ctx.oauth.getUser();
            if (!cancelled) setUserLabel(user.name ?? user.email ?? user.sub);
          } else if (!cancelled) {
            notice("Not signed in. Use /login (or run `deyin login`) to connect your Openference account.", "warn");
          }
        } catch {
          // profile fetch failed; stay signed-out
        }
        const route = cliProviderRouting(ctx, ctx.config.providerId);
        const models = await listModels({ apiBaseUrl: route.apiBaseUrl }, route.getToken);
        if (!cancelled) setModelList(models);
      }
      const update = await updateNotice(ctx.storage);
      if (update && !cancelled) setUpdateLine(update);
      if (!cancelled) {
        if (!initial.remote && initial.resumeId) loadSession(initial.resumeId);
        else if (!initial.remote && initial.continueLast) loadSession(ctx.sessions.latest(ctx.cwd)?.id);
        if (initial.openSessionPicker) openPicker("session");
      }
    })();
    return () => {
      cancelled = true;
      for (const c of mcpRef.current) void c.close();
      shellRef.current?.dispose();
    };
  }, []);

  // Spinner tick while something is in flight.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setSpin((s) => (s + 1) % SPINNER.length), 90);
    return () => clearInterval(timer);
  }, [running]);

  const handleEvent = useCallback(
    (event: AgentEvent): void => {
      switch (event.type) {
        case "text-delta":
          setStreamText((t) => t + event.delta);
          break;
        case "reasoning-delta":
          setStreamReasoning((t) => t + event.delta);
          break;
        case "assistant-message": {
          setStreamText("");
          setStreamReasoning("");
          const m = event.message;
          if (m.role === "assistant") {
            if (m.reasoning && m.reasoning.trim()) {
              pushItem({ kind: "reasoning", id: nextId(), text: tailLines(m.reasoning.trim(), 4) });
            }
            if (m.content.trim()) pushItem({ kind: "assistant", id: nextId(), text: m.content });
          }
          break;
        }
        case "tool-start":
          toolSummaryRef.current.set(event.call.id, event.summary);
          setActiveTool({ name: event.call.name, summary: event.summary });
          break;
        case "tool-end": {
          setActiveTool(null);
          const status = event.denied ? "denied" : event.ok ? "done" : "error";
          pushItem({
            kind: "tool",
            id: nextId(),
            name: event.call.name,
            summary: toolSummaryRef.current.get(event.call.id) ?? "",
            status,
            preview: toolPreview(event.result),
          });
          break;
        }
        case "todos":
          setTodos(event.todos);
          break;
        case "usage":
          setUsageTokens(event.usage.totalTokens);
          break;
        case "compaction":
          notice(`Context compacted (${event.droppedMessages} messages dropped, ${event.truncatedToolResults} tool results truncated).`);
          break;
        case "run-summary": {
          const s = event.summary;
          notice(
            `Run: ${s.steps} steps, ${s.toolCalls} tool calls (${s.deniedCalls} denied, ${s.failedCalls} failed, ` +
              `${s.duplicateResults} duplicates elided, ${s.loopGuardTrips} guard trips), cache hit rate ${(s.cacheHitRate * 100).toFixed(1)}%.`,
          );
          break;
        }
        default:
          break;
      }
    },
    [notice, pushItem],
  );

  const startRun = useCallback(
    async (text: string): Promise<void> => {
      if (initial.remote) {
        const firstRemotePrompt = !remoteStartedRef.current;
        remoteStartedRef.current = true;
        pushItem({ kind: "user", id: nextId(), text });
        setRunning(true);
        setStreamText("");
        setStreamReasoning("");
        const controller = new AbortController();
        abortRef.current = controller;
        let exitCode: number;
        try {
          exitCode = await runRemote({
            url: initial.remote.url,
            prompt: text,
            // The current /v1/run transport has no interactive permission
            // round-trip. The attached TUI therefore opts into the same
            // explicit auto-approval mode as `--auto`.
            yes: true,
            continueLast: firstRemotePrompt && initial.remote.continueLast === true,
            resumeId: remoteSessionIdRef.current ?? undefined,
            fork: firstRemotePrompt && initial.remote.fork === true,
            token: initial.remote.token,
            username: initial.remote.username,
            password: initial.remote.password,
            signal: controller.signal,
            json: true,
            stdout: { write: () => true } as unknown as NodeJS.WritableStream,
            onEvent: (value) => {
              if (!value || typeof value !== "object") return;
              const event = value as { type?: string; sessionId?: unknown; error?: unknown };
              if (event.type === "result") {
                if (typeof event.sessionId === "string") {
                  remoteSessionIdRef.current = event.sessionId;
                  sessionIdRef.current = event.sessionId;
                }
                return;
              }
              if (event.type === "error") {
                notice(typeof event.error === "string" ? event.error : "remote run failed", "error");
                return;
              }
              handleEvent(value as AgentEvent);
            },
          });
          if (exitCode !== 0 && !controller.signal.aborted) notice(`Remote run exited with code ${exitCode}.`, "error");
        } catch (err) {
          if (!controller.signal.aborted) notice(`Remote run failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        } finally {
          setRunning(false);
          setActiveTool(null);
          setStreamText("");
          setStreamReasoning("");
          abortRef.current = null;
        }
        return;
      }
      const agent = agentDef();
      if (!sessionIdRef.current) {
        const meta = ctx.sessions.create({ cwd: ctx.cwd, model: `${ctx.config.providerId}::${model}`, agent: agent.name });
        sessionIdRef.current = meta.id;
        newSessionRef.current = true;
        const system: AgentMessage = {
          role: "system",
          content: buildSystemPrompt({
            cwd: ctx.cwd,
            agent,
            contextFiles: contextFilesRef.current,
            skills: capsRef.current?.skills,
            projectToolchain: projectToolchainRef.current,
          }),
        };
        messagesRef.current = [system];
      }

      pushItem({ kind: "user", id: nextId(), text });
      const caps = capsRef.current;
      const startHook = caps
        ? await runHooks(caps.hooks, "sessionStart", "sessionStart", {
            cwd: ctx.cwd,
            sessionId: sessionIdRef.current ?? "",
          })
        : { blocked: false, additionalContext: [] as string[] };
      if (startHook.blocked) {
        notice(startHook.reason ?? "sessionStart hook blocked the run", "error");
        return;
      }
      const hookContext = startHook.additionalContext?.filter(Boolean) ?? [];
      if (hookContext.length > 0 && newSessionRef.current) {
        const system = messagesRef.current[0];
        if (system?.role === "system") {
          system.content += `\n\n<session_hook_context>\n${hookContext.join("\n\n")}\n</session_hook_context>`;
        }
      }
      if (newSessionRef.current) ctx.sessions.append(sessionIdRef.current!, messagesRef.current[0]!);
      const prompt = hookContext.length > 0 && !newSessionRef.current
        ? `${text}\n\n<session_hook_context>\n${hookContext.join("\n\n")}\n</session_hook_context>`
        : text;
      const userMessage: AgentMessage = { role: "user", content: prompt };
      messagesRef.current.push(userMessage);
      ctx.sessions.append(sessionIdRef.current, userMessage);

      setRunning(true);
      setStreamText("");
      setStreamReasoning("");
      const controller = new AbortController();
      abortRef.current = controller;
      const before = messagesRef.current.length;
      const route = cliProviderRouting(ctx, ctx.config.providerId);
      let runStarted = false;
      let stopReason = "error";
      const checkpointId = randomUUID();
      const checkpoints = new CheckpointStore(ctx.storage);
      let checkpointWrites: Promise<void> = Promise.resolve();
      let checkpointCount = 0;
      const onRunEvent = (event: AgentEvent): void => {
        if (event.type === "file-change") {
          checkpointCount += 1;
          checkpointWrites = checkpointWrites.then(async () => {
            await checkpoints.record(sessionIdRef.current!, checkpointId, {
              path: event.change.path,
              before: event.change.before,
              after: event.change.after,
              operation: event.change.before === "" ? "write" : event.change.after === "" ? "delete" : "edit",
            });
          });
        }
        handleEvent(event);
      };

      try {
        if (!shellRef.current) shellRef.current = await createCliShell(ctx.cwd);
        runStarted = true;
        const imageStore = new ImageStore(join(ctx.dataDir, "images"));
        const imageGen = createImageBridge({
          store: imageStore,
          threadId: sessionIdRef.current!,
          apiBaseUrl: route.apiBaseUrl,
          getToken: route.getToken,
          models: () => modelList
            .filter((entry) => entry.kind === "image" || entry.imageOutput)
            .map((entry) => ({ id: entry.id, route: entry.kind === "image" ? "endpoint" as const : "chat" as const })),
          cwd: ctx.cwd,
          signal: controller.signal,
        });
        const result = await runAgent({
          apiBaseUrl: route.apiBaseUrl,
          getToken: route.getToken,
          model,
          apiFormat: route.apiFormat,
          authHeader: route.authHeader,
          contextLength: modelList.find((m) => m.id === model)?.contextLength,
          messages: messagesRef.current,
          tools: toolsRef.current,
          permissions: permEngineRef.current,
          resolvePermission: requestPermission,
          router: createRoleRouter({
            roleModels: ctx.config.roleModels,
            base: {
              model,
              providerId: ctx.config.providerId,
              apiBaseUrl: route.apiBaseUrl,
              getToken: route.getToken,
              apiFormat: route.apiFormat,
              authHeader: route.authHeader,
              contextLength: modelList.find((m) => m.id === model)?.contextLength,
            },
            resolveProvider: (providerId) => cliProviderRouting(ctx, providerId),
            getContextLength: (providerId, modelId) => {
              const provider = ctx.agents.listProviders(true).find((entry) => entry.id === providerId);
              return provider?.models.find((entry) => entry.id === modelId)?.contextLength ??
                (providerId === ctx.config.providerId && modelId === model
                  ? modelList.find((entry) => entry.id === modelId)?.contextLength
                  : undefined);
            },
          }),
          beforeTool: async (call, args, summary) => {
            const hooks = capsRef.current?.hooks ?? [];
            const pre = await runHooks(hooks, "preToolUse", call.name, {
              tool: call.name,
              args,
              summary,
              cwd: ctx.cwd,
            });
            if (pre.blocked) return { block: pre.reason ?? "preToolUse hook" };
            if (call.name === "bash") {
              const command = typeof args.command === "string" ? args.command : "";
              const shellHook = await runHooks(hooks, "beforeShellExecution", command, { command, cwd: ctx.cwd });
              if (shellHook.blocked) return { block: shellHook.reason ?? "beforeShellExecution hook" };
            }
            return undefined;
          },
          afterTool: async (call, resultText, ok) => {
            await runHooks(capsRef.current?.hooks ?? [], "postToolUse", call.name, {
              tool: call.name,
              ok,
              resultChars: resultText.length,
              cwd: ctx.cwd,
            });
          },
          toolContext: {
            imageGen,
            skills: capsRef.current?.skills.map((s) => ({ name: s.name, path: s.path, description: s.description })),
            waitForJobs: async (jobIds, blockUntilMs) => {
              const sessionId = sessionIdRef.current;
              if (!sessionId) return [];
              const jobs = await getSessionJobsManager(sessionId, join(ctx.dataDir, "jobs")).waitFor(
                jobIds,
                blockUntilMs,
              );
              return jobs.map((j) => ({
                id: j.id,
                label: j.label,
                status: j.status,
                result: j.result,
                error: j.error,
              }));
            },
            goalText: goalTextRef.current,
            onGoalReport: (report) => {
              if (report.met) notice(`Goal met: ${report.reason}`);
              else notice(`Goal not met: ${report.reason}`, "warn");
            },
            resolveInteraction: (request) =>
              new Promise<string>((resolve) => {
                if (request.type !== "ask-question") {
                  resolve("Interaction not supported.");
                  return;
                }
                setQuestion({
                  request,
                  resolve: (answers) => {
                    setQuestion(null);
                    resolve(answers);
                  },
                });
              }),
            memory: ctx.config.memoryEnabled ? ctx.memory : undefined,
          },
          memory: ctx.config.memoryEnabled ? ctx.memory : undefined,
          onEvent: onRunEvent,
          onMessage: (message) => {
            if (sessionIdRef.current) ctx.sessions.append(sessionIdRef.current, message);
          },
          cwd: ctx.cwd,
          shell: shellRef.current ?? undefined,
          thinking: ctx.config.thinking,
          wire: {
            enableCompression: true,
            compressionMode: "balanced",
            enablePromptCaching: true,
            provider: resolveWireProvider({ providerId: ctx.config.providerId, model, cwd: ctx.cwd, apiFormat: route.apiFormat }),
            model,
          },
          promptCacheKey: buildPromptCacheKeyFor({ providerId: ctx.config.providerId, model, cwd: ctx.cwd }),
          imageOutput: modelList.find((entry) => entry.id === model)?.imageOutput === true,
          maxSteps: agent.maxSteps ?? ctx.config.maxSteps,
          signal: controller.signal,
          // The wire and prompt cache settings above keep TUI transcripts aligned
          // with Desktop, web, and headless runs.
        });
        await checkpointWrites;
        const tokens = result.usage.totalTokens || estimateTokens(messagesRef.current.slice(before));
        ctx.usage.record({ model: `${ctx.config.providerId}::${model}`, tokens, newSession: newSessionRef.current });
        newSessionRef.current = false;
        if (result.summary && sessionIdRef.current) {
          ctx.sessions.appendEvent(sessionIdRef.current, { kind: "run-summary", summary: result.summary });
        }
        stopReason = result.reason;
        if (result.reason === "max-steps") notice("Stopped: step limit reached. Send a message to continue.", "warn");
        if (result.reason === "aborted") notice("Cancelled.", "warn");
        if (checkpointCount > 0) {
          notice(`Checkpoint ${checkpointId} recorded (${checkpointCount} file change${checkpointCount === 1 ? "" : "s"}).`);
        }
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          notice("Not signed in. Use /login or run `deyin login` in another terminal.", "error");
        } else {
          notice(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
      } finally {
        await checkpointWrites.catch(() => undefined);
        if (runStarted) {
          await runHooks(capsRef.current?.hooks ?? [], "stop", "stop", { reason: stopReason, cwd: ctx.cwd });
        }
        setRunning(false);
        setActiveTool(null);
        setStreamText("");
        setStreamReasoning("");
        abortRef.current = null;
      }
    },
    [agentDef, ctx, handleEvent, initial, model, modelList, notice, pushItem, requestPermission],
  );

  const openPicker = useCallback(
    (kind: PickerState["kind"]): void => {
      if (kind === "model") {
        if (initial.remote) {
          notice("Remote attach uses the server's configured model. Change it on the server or start a local TUI.", "warn");
          return;
        }
        setPicker({
          kind,
          title: "Select model",
          items: modelList.map((m) => ({
            value: m.id,
            label: m.id,
            hint: m.contextLength ? `${Math.round(m.contextLength / 1000)}k ctx` : undefined,
          })),
        });
      } else if (kind === "agent") {
        setPicker({
          kind,
          title: "Select agent",
          items: resolveAgents(ctx.config).map((a) => ({ value: a.name, label: a.name, hint: a.description })),
        });
      } else {
        setPicker({
          kind,
          title: "Resume session",
          items: ctx.sessions.list().slice(0, 30).map((s) => ({
            value: s.id,
            label: s.title || s.id,
            hint: `${s.updatedAt.slice(0, 16).replace("T", " ")} \u00b7 ${s.messageCount} msgs`,
          })),
        });
      }
    },
    [ctx.config, ctx.sessions, initial, modelList, notice],
  );

  const onPickerSelect = useCallback(
    (value: string): void => {
      const kind = picker?.kind;
      setPicker(null);
      if (kind === "model") {
        setModel(value);
        notice(`Model set to ${value}.`);
      } else if (kind === "agent") {
        setAgentName(value);
        const agent = resolveAgent(ctx.config, value) ?? BUILD_AGENT;
        permEngineRef.current = new PermissionEngine({
          agentRules: agent.permissions,
          configRules: ctx.config.permissions,
        });
        const system = messagesRef.current[0];
        if (system && system.role === "system") {
          // Replace the object rather than mutating it: the token price memo is
          // a WeakMap keyed on message identity, so an in-place content change
          // leaves a stale price cached for the system prompt forever. This is
          // the same reason `applyPrune` swaps objects instead of editing them.
          messagesRef.current[0] = {
            ...system,
            content: buildSystemPrompt({
              cwd: ctx.cwd,
              agent,
              contextFiles: contextFilesRef.current,
              skills: capsRef.current?.skills,
              projectToolchain: projectToolchainRef.current,
            }),
          };
        }
        notice(`Agent set to ${value}.`);
      } else if (kind === "session") {
        loadSession(value);
      }
    },
    [ctx.config, ctx.cwd, loadSession, notice, picker],
  );

  const doCompact = useCallback(async (): Promise<void> => {
    if (running) {
      notice("Wait for the current run to finish (or press esc to cancel it).", "warn");
      return;
    }
    if (messagesRef.current.length < 3) {
      notice("Nothing to compact yet.", "warn");
      return;
    }
    const route = cliProviderRouting(ctx, ctx.config.providerId);
    const token = await route.getToken();
    if (!token) {
      if (route.provider?.local !== true) notice("Not signed in.", "error");
      return;
    }
    const beforeTokens = estimateTokens(messagesRef.current);
    notice("Compacting conversation\u2026");
    try {
      const compacted = await compactWithModel({
        apiBaseUrl: route.apiBaseUrl,
        token,
        model,
        apiFormat: route.apiFormat,
        authHeader: route.authHeader,
        messages: messagesRef.current,
      });
      if (compacted === messagesRef.current) {
        notice("Nothing older than the recent tail to compact yet.", "warn");
        return;
      }
      messagesRef.current = compacted;
      const meta = ctx.sessions.create({ cwd: ctx.cwd, model: `${ctx.config.providerId}::${model}`, agent: agentName });
      sessionIdRef.current = meta.id;
      for (const message of messagesRef.current) ctx.sessions.append(meta.id, message);
      notice(`Compacted ~${beforeTokens} \u2192 ~${estimateTokens(messagesRef.current)} tokens (continued as ${meta.id}).`);
    } catch (err) {
      notice(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [agentName, ctx, model, notice, running]);

  const doLogin = useCallback(async (): Promise<void> => {
    if (await ctx.oauth.isAuthenticated()) {
      notice("Already signed in.");
      return;
    }
    notice("Starting device login\u2026");
    try {
      await loginWithDevice(ctx.oauth, {
        onAuthorization: ({ userCode, verificationUri, verificationUriComplete }) => {
          notice(`Open ${verificationUriComplete ?? verificationUri} and enter code: ${userCode}`, "warn");
        },
      });
      const user = await ctx.oauth.getUser();
      setUserLabel(user.name ?? user.email ?? user.sub);
      notice(`Signed in as ${user.name ?? user.sub}.`);
      const route = cliProviderRouting(ctx, ctx.config.providerId);
      setModelList(await listModels({ apiBaseUrl: route.apiBaseUrl }, route.getToken));
    } catch (err) {
      notice(`Login failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [ctx, notice]);

  const handleOpenEditor = useCallback((): void => {
    if (running) {
      notice("Wait for the current run to finish.", "warn");
      return;
    }
    try {
      const edited = openInEditor(input);
      if (edited !== null && edited.trim().length > 0) {
        setInput(edited.trimEnd());
        notice("Prompt loaded from external editor.");
      } else if (edited !== null) {
        setInput("");
        notice("Prompt cleared in external editor.");
      } else {
        notice("Editor closed without changes.");
      }
    } catch (err) {
      notice(`Failed to launch editor: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [input, notice, running]);

  const handleSlash = useCallback(
    (text: string): void => {
      const command = text.split(/\s+/)[0] ?? "";
      switch (command) {
        case "/help":
          notice(SLASH_COMMANDS.map((c) => `${c.name.padEnd(11)} ${c.description}`).join("\n"));
          break;
        case "/undo": {
          if (running) {
            notice("Wait for the current run to finish (or press esc to cancel it first).", "warn");
            break;
          }
          if (messagesRef.current.length <= 1) {
            notice("Nothing to undo in this session.", "warn");
            break;
          }
          void (async () => {
            let revertedCount = 0;
            const currentSessionId = sessionIdRef.current;
            if (currentSessionId) {
              try {
                const store = new CheckpointStore(ctx.storage);
                const entries = store.list(currentSessionId);
                const activeEntries = entries.filter((e) => e.revertedAt === undefined);
                if (activeEntries.length > 0) {
                  const latestCheckpointId = activeEntries[activeEntries.length - 1]?.checkpointId;
                  if (latestCheckpointId) {
                    const ops = checkpointFileOpsFromRoot(ctx.cwd, async (p) => resolvePathInWorkspace(ctx.cwd, p));
                    const res = await revertCheckpoint(store, ctx.storage, ops, currentSessionId, latestCheckpointId);
                    if (res.ok) {
                      revertedCount = res.revertedPaths.length;
                    }
                  }
                }
              } catch (err) {
                notice(`Checkpoint revert warning: ${err instanceof Error ? err.message : String(err)}`, "warn");
              }
            }

            let lastUserIdx = -1;
            for (let i = messagesRef.current.length - 1; i >= 0; i--) {
              if (messagesRef.current[i]?.role === "user") {
                lastUserIdx = i;
                break;
              }
            }

            if (lastUserIdx >= 0) {
              messagesRef.current = messagesRef.current.slice(0, lastUserIdx);
              if (currentSessionId && messagesRef.current.length > 0) {
                const meta = ctx.sessions.create({
                  cwd: ctx.cwd,
                  model: `${ctx.config.providerId}::${model}`,
                  agent: agentName,
                });
                sessionIdRef.current = meta.id;
                for (const msg of messagesRef.current) {
                  ctx.sessions.append(meta.id, msg);
                }
              }

              // Reconcile todos from remaining messages
              let remainingTodos: TodoItem[] = [];
              for (let i = messagesRef.current.length - 1; i >= 0; i--) {
                const msg = messagesRef.current[i];
                if (msg?.role === "assistant" && Array.isArray(msg.toolCalls)) {
                  for (const tc of msg.toolCalls) {
                    if (tc.name === "todo_write" || tc.name === "todo") {
                      try {
                        const parsed = JSON.parse(tc.arguments);
                        if (Array.isArray(parsed.todos)) {
                          remainingTodos = parsed.todos;
                          break;
                        }
                      } catch {
                        // ignore parse errors
                      }
                    }
                  }
                  if (remainingTodos.length > 0) break;
                }
              }
              setTodos(remainingTodos);

              setItems(messagesToItems(messagesRef.current));
              const revertMsg = revertedCount > 0 ? ` (reverted ${revertedCount} file change(s))` : "";
              notice(`Undid last turn${revertMsg}. Conversation rewound.`);
            } else {
              notice("No previous user turn found to undo.", "warn");
            }
          })();
          break;
        }
        case "/editor":
          handleOpenEditor();
          break;
        case "/map": {
          const query = text.slice("/map".length).trim();
          void (async () => {
            try {
              const result = await repoMapTool.execute({ query: query || undefined }, { cwd: ctx.cwd, todos: [] });
              notice(result);
            } catch (err) {
              notice(`Could not generate repo map: ${err instanceof Error ? err.message : String(err)}`, "error");
            }
          })();
          break;
        }
        case "/exit":
        case "/quit":
          abortRef.current?.abort();
          for (const c of mcpRef.current) void c.close();
          exit();
          break;
        case "/new":
          abortRef.current?.abort();
          messagesRef.current = [];
          sessionIdRef.current = null;
          if (initial.remote) {
            remoteSessionIdRef.current = null;
            remoteStartedRef.current = false;
          }
          goalTextRef.current = undefined;
          setTodos([]);
          setUsageTokens(0);
          pushItem({ kind: "notice", id: nextId(), text: "\u2500\u2500 new session \u2500\u2500", tone: "info" });
          break;
        case "/model":
          openPicker("model");
          break;
        case "/agent":
          openPicker("agent");
          break;
        case "/sessions":
          openPicker("session");
          break;
        case "/compact":
          void doCompact();
          break;
        case "/usage": {
          const stats = ctx.usage.stats();
          notice(
            `Tokens: ${stats.totalTokens.toLocaleString()} \u00b7 messages: ${stats.messages} \u00b7 sessions: ${stats.sessions} \u00b7 active days: ${stats.activeDays} (streak ${stats.currentStreak})`,
          );
          break;
        }
        case "/login":
          void doLogin();
          break;
        case "/memory": {
          const facts = ctx.memory.list();
          if (facts.length === 0) {
            notice("No saved memories. Save one with /remember <note> (the agent can also use its remember tool).");
            break;
          }
          notice(
            facts
              .slice(0, 20)
              .map((f) => `\u2022 ${f.scope}/${f.name} (${f.type}) — ${f.description || f.title}`)
              .join("\n") + (facts.length > 20 ? `\n… ${facts.length - 20} more` : ""),
          );
          break;
        }
        case "/remember": {
          const note = text.slice("/remember".length).trim();
          if (!note) {
            notice("Usage: /remember <note> — e.g. /remember the release branch is main", "warn");
            break;
          }
          try {
            const fact = ctx.memory.create({
              name: `note-${note.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "note"}`,
              title: note.slice(0, 80),
              type: "project",
              body: note,
            });
            notice(`Saved memory ${fact.scope}/${fact.name} (revision 1).`);
          } catch (err) {
            notice(`Could not save memory: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          break;
        }
        case "/goal": {
          if (
            applyGoalCommandText(text, (goal) => {
              goalTextRef.current = goal ?? undefined;
              notice(goal ? `Goal set: ${goal}` : "Goal cleared.");
            })
          ) {
            break;
          }
          notice("Usage: /goal <objective> — send /goal alone to clear", "warn");
          break;
        }
        default:
          notice(`Unknown command ${command}. Try /help.`, "warn");
      }
    },
    [ctx.usage, doCompact, doLogin, exit, handleOpenEditor, initial, notice, openPicker, pushItem],
  );

  const runEscapeCommand = useCallback(
    async (cmd: string): Promise<void> => {
      if (running) {
        notice("A run is already in progress (esc to cancel it first).", "warn");
        return;
      }
      historyRef.current.push(`!${cmd}`);
      pushItem({ kind: "user", id: nextId(), text: `! ${cmd}` });
      setRunning(true);
      setActiveTool({ name: "shell", summary: cmd });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        if (!shellRef.current) {
          shellRef.current = await createCliShell(ctx.cwd);
        }
        const res = await executeShellCommand(cmd, ctx.cwd, {
          shell: shellRef.current,
          signal: controller.signal,
        });
        const status = res.exitCode === 0 ? "done" : "error";
        pushItem({
          kind: "tool",
          id: nextId(),
          name: "shell",
          summary: cmd,
          status,
          preview: toolPreview(res.output, 20),
        });

        const userMsg: AgentMessage = {
          role: "user",
          content: `! ${cmd}\n\n\`\`\`\n${res.output || "(no output)"}\n\`\`\``,
        };
        if (!sessionIdRef.current) {
          const agent = agentDef();
          const meta = ctx.sessions.create({ cwd: ctx.cwd, model: `${ctx.config.providerId}::${model}`, agent: agent.name });
          sessionIdRef.current = meta.id;
          newSessionRef.current = false;
          const system: AgentMessage = {
            role: "system",
            content: buildSystemPrompt({
              cwd: ctx.cwd,
              agent,
              contextFiles: contextFilesRef.current,
              skills: capsRef.current?.skills,
              projectToolchain: projectToolchainRef.current,
            }),
          };
          messagesRef.current = [system, userMsg];
          ctx.sessions.append(meta.id, system);
          ctx.sessions.append(meta.id, userMsg);
        } else {
          messagesRef.current.push(userMsg);
          ctx.sessions.append(sessionIdRef.current, userMsg);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          notice(`Shell command error: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
      } finally {
        if (controller.signal.aborted) {
          notice("Command cancelled.");
        }
        setRunning(false);
        setActiveTool(null);
        abortRef.current = null;
      }
    },
    [agentDef, ctx, model, notice, pushItem, running],
  );

  const handleSubmit = useCallback(
    (raw: string): void => {
      const text = raw.trim();
      setInput("");
      if (!text) return;
      if (text.startsWith("!")) {
        const cmd = text.slice(1).trim();
        if (!cmd) {
          notice("Usage: !<command> — e.g. !git status", "warn");
          return;
        }
        void runEscapeCommand(cmd);
        return;
      }
      if (text.startsWith("/")) {
        const invocation = matchCommand(text);
        if (invocation) {
          const builtinName = `/${invocation.name}`;
          if (SLASH_COMMANDS.some((c) => c.name === builtinName)) {
            handleSlash(text);
            return;
          }
          const caps = capsRef.current;
          if (caps) {
            const resolved = resolveCliPrompt(text, caps);
            if (resolved.error) {
              notice(resolved.error, "warn");
              return;
            }
            if (running) {
              notice("A run is already in progress (esc to cancel it first).", "warn");
              return;
            }
            historyRef.current.push(text);
            void startRun(resolved.prompt);
            return;
          }
        }
      }
      if (running) {
        notice("A run is already in progress (esc to cancel it first).", "warn");
        return;
      }
      historyRef.current.push(text);
      void startRun(text);
    },
    [handleSlash, notice, runEscapeCommand, running, startRun],
  );

  // Global keys: esc cancels, double ctrl+c quits.
  useInput((char, key) => {
    if (key.escape && !permission && !picker) {
      if (running) {
        abortRef.current?.abort();
      } else {
        setInput("");
      }
      return;
    }
    if (key.ctrl && char === "c") {
      if (exitArmed) {
        abortRef.current?.abort();
        for (const c of mcpRef.current) void c.close();
        exit();
        return;
      }
      if (running) abortRef.current?.abort();
      setExitArmed(true);
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      exitTimerRef.current = setTimeout(() => setExitArmed(false), 1500);
    }
  });

  const suggestions = input.startsWith("/")
    ? SLASH_COMMANDS.filter((c) => c.name.startsWith(input.split(/\s+/)[0] ?? "")).slice(0, 6)
    : [];

  const activeTodo = todos.find((t) => t.status === "in_progress");
  const doneTodos = todos.filter((t) => t.status === "completed").length;

  return (
    <Box flexDirection="column">
      <Static items={items}>{(item) => <ItemView key={item.id} item={item} />}</Static>

      {running && streamReasoning ? (
        <Text dimColor italic>
          {`${SPINNER[spin]} thinking ${tailLines(streamReasoning, 1).slice(-100)}`}
        </Text>
      ) : null}
      {streamText ? <Text>{renderMarkdown(tailLines(streamText, 24))}</Text> : null}
      {activeTool ? (
        <Text color="yellow">{`${SPINNER[spin]} ${activeTool.name} ${activeTool.summary}`}</Text>
      ) : null}
      {running && todos.length > 0 ? (
        <Text dimColor>{`todos ${doneTodos}/${todos.length}${activeTodo ? ` \u00b7 ${activeTodo.content}` : ""}`}</Text>
      ) : null}

      {permission ? <PermissionPrompt request={permission.request} onDecision={permission.resolve} /> : null}
      {question ? (
        <QuestionPrompt
          title={question.request.title}
          questions={question.request.questions}
          onSubmit={(answers) => question.resolve(JSON.stringify(answers, null, 2))}
          onCancel={() =>
            question.resolve(
              JSON.stringify({ __cancelled: "AskQuestion was cancelled before answers were returned." }),
            )
          }
        />
      ) : null}
      {picker ? (
        <Picker title={picker.title} items={picker.items} onSelect={onPickerSelect} onCancel={() => setPicker(null)} />
      ) : null}

      {suggestions.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {suggestions.map((s) => (
            <Text key={s.name} dimColor>
              {s.name.padEnd(11)} {s.description}
            </Text>
          ))}
        </Box>
      ) : null}

      <Composer
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        onOpenEditor={handleOpenEditor}
        active={!permission && !picker && !question}
        history={historyRef.current}
        placeholder={running ? "running\u2026 esc to cancel" : 'Ask anything \u00b7 "/" for commands \u00b7 "!" for shell \u00b7 Ctrl+O for editor'}
      />

      {updateLine ? <Text color="yellow">{updateLine}</Text> : null}
      <Box justifyContent="space-between">
        <Text dimColor>{`${initial.remote ? "remote" : model} \u00b7 ${agentName} \u00b7 ${shortenPath(ctx.cwd)} \u00b7 ${userLabel ?? (initial.remote ? "attached" : "signed out")}`}</Text>
        <Text dimColor>
          {`${usageTokens > 0 ? `${usageTokens.toLocaleString()} tok \u00b7 ` : ""}${
            exitArmed ? "press ctrl+c again to quit" : running ? "esc to cancel" : "ctrl+c twice to quit"
          }`}
        </Text>
      </Box>
    </Box>
  );
}

function shortenPath(path: string): string {
  const home = process.env.HOME ?? "";
  const short = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  return short.length > 40 ? `\u2026${short.slice(-39)}` : short;
}

function ItemView({ item }: { item: TranscriptItem }): JSX.Element {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text>
            <Text color="cyan" bold>
              {"\u276f "}
            </Text>
            <Text bold>{item.text}</Text>
          </Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1} flexDirection="column">
          <Text>{renderMarkdown(item.text)}</Text>
        </Box>
      );
    case "reasoning":
      return (
        <Text dimColor italic>
          {item.text}
        </Text>
      );
    case "tool": {
      const glyph = item.status === "done" ? "\u2713" : item.status === "denied" ? "\u2298" : "\u2717";
      const color = item.status === "done" ? "green" : item.status === "denied" ? "yellow" : "red";
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={color}>{glyph} </Text>
            <Text bold>{item.name}</Text>
            {item.summary ? <Text dimColor>{` ${item.summary}`}</Text> : null}
          </Text>
          {item.preview ? <Text dimColor>{indent(item.preview)}</Text> : null}
        </Box>
      );
    }
    case "notice": {
      const color = item.tone === "error" ? "red" : item.tone === "warn" ? "yellow" : undefined;
      return (
        <Text color={color} dimColor={item.tone === "info"}>
          {item.text}
        </Text>
      );
    }
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}
