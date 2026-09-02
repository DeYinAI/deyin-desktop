import {
  AuthRequiredError,
  BUILD_AGENT,
  PermissionEngine,
  buildSystemPrompt,
  compactWithModel,
  connectMcpServers,
  createBuiltinRegistry,
  estimateTokens,
  getSessionJobsManager,
  loadContextFiles,
  applyGoalCommandText,
  matchCommand,
  resolveAgent,
  resolveAgents,
  runAgent,
  type AgentEvent,
  type AgentMessage,
  type CapabilitySnapshot,
  type ContextFile,
  type McpConnection,
  type PermissionDecision,
  type PermissionRequest,
  type InteractionRequest,
  type TodoItem,
  type ToolRegistry,
} from "@deyin/agent-core";
import { listModels, type ModelInfo } from "@deyin/host-core";
import { buildPromptCacheKeyFor, resolveWireProvider } from "@deyin/host-core/shared";
import { loginWithDevice } from "@deyin/oauth-client/node";
import { join } from "node:path";
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import type { CliContext } from "../context.js";
import { tokenSource } from "../context.js";
import { loadCliCapabilities, resolveCliPrompt } from "../capabilities.js";
import { registerCliSubagentTool } from "../subagents.js";
import { updateNotice } from "../version.js";
import { Composer } from "./Composer.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { QuestionPrompt } from "./QuestionPrompt.js";
import { Picker, type PickerItem } from "./Picker.js";
import { messagesToItems, nextId, toolPreview, type TranscriptItem } from "./items.js";
import { renderMarkdown, tailLines } from "./markdown.js";

const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

const SLASH_COMMANDS: { name: string; description: string }[] = [
  { name: "/help", description: "Show available commands" },
  { name: "/model", description: "Switch model" },
  { name: "/agent", description: "Switch agent (build/plan/custom)" },
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
  const [model, setModel] = useState(ctx.config.model);
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
  const newSessionRef = useRef(false);
  const toolsRef = useRef<ToolRegistry>(createBuiltinRegistry());
  const abortRef = useRef<AbortController | null>(null);
  const goalTextRef = useRef<string | undefined>(undefined);
  const historyRef = useRef<string[]>([]);
  const contextFilesRef = useRef<ContextFile[]>([]);
  const capsRef = useRef<CapabilitySnapshot | null>(null);
  const mcpRef = useRef<McpConnection[]>([]);
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
      contextFilesRef.current = await loadContextFiles(ctx.cwd);
      capsRef.current = await loadCliCapabilities(ctx.cwd);
      const connections = await connectMcpServers(ctx.config.mcpServers, toolsRef.current, {
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
      const models = await listModels(ctx.config, tokenSource(ctx));
      if (!cancelled) setModelList(models);
      const update = await updateNotice(ctx.storage);
      if (update && !cancelled) setUpdateLine(update);
      if (!cancelled) {
        if (initial.resumeId) loadSession(initial.resumeId);
        else if (initial.continueLast) loadSession(ctx.sessions.latest(ctx.cwd)?.id);
        if (initial.openSessionPicker) openPicker("session");
      }
    })();
    return () => {
      cancelled = true;
      for (const c of mcpRef.current) void c.close();
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
      const agent = agentDef();
      if (!sessionIdRef.current) {
        const meta = ctx.sessions.create({ cwd: ctx.cwd, model, agent: agent.name });
        sessionIdRef.current = meta.id;
        newSessionRef.current = true;
        const system: AgentMessage = {
          role: "system",
          content: buildSystemPrompt({
            cwd: ctx.cwd,
            agent,
            contextFiles: contextFilesRef.current,
            skills: capsRef.current?.skills,
          }),
        };
        messagesRef.current = [system];
        ctx.sessions.append(meta.id, system);
      }

      pushItem({ kind: "user", id: nextId(), text });
      const userMessage: AgentMessage = { role: "user", content: text };
      messagesRef.current.push(userMessage);
      ctx.sessions.append(sessionIdRef.current, userMessage);

      setRunning(true);
      setStreamText("");
      setStreamReasoning("");
      const controller = new AbortController();
      abortRef.current = controller;
      const before = messagesRef.current.length;

      try {
        const result = await runAgent({
          apiBaseUrl: ctx.config.apiBaseUrl,
          getToken: tokenSource(ctx),
          model,
          contextLength: modelList.find((m) => m.id === model)?.contextLength,
          messages: messagesRef.current,
          tools: toolsRef.current,
          permissions: permEngineRef.current,
          resolvePermission: requestPermission,
          toolContext: {
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
          onEvent: handleEvent,
          onMessage: (message) => {
            if (sessionIdRef.current) ctx.sessions.append(sessionIdRef.current, message);
          },
          cwd: ctx.cwd,
          thinking: ctx.config.thinking,
          maxSteps: agent.maxSteps ?? ctx.config.maxSteps,
          signal: controller.signal,
          // The interactive TUI used to pass neither of these, so `provider`
          // defaulted to "auto", no cache_control marker was ever emitted, and
          // the whole prompt was re-read cold on every step. Desktop, web and
          // headless all pass this block; parity matters most here, because a
          // TUI session is the longest-lived transcript we have.
          wire: {
            enableCompression: true,
            compressionMode: "balanced",
            enablePromptCaching: true,
            provider: resolveWireProvider({
              providerId: "cli",
              model,
              cwd: ctx.cwd,
              apiFormat: "chat-completions",
            }),
            model,
          },
          promptCacheKey: buildPromptCacheKeyFor({ providerId: "cli", model, cwd: ctx.cwd }),
        });
        const tokens = result.usage.totalTokens || estimateTokens(messagesRef.current.slice(before));
        ctx.usage.record({ model, tokens, newSession: newSessionRef.current });
        newSessionRef.current = false;
        if (result.summary && sessionIdRef.current) {
          ctx.sessions.appendEvent(sessionIdRef.current, { kind: "run-summary", summary: result.summary });
        }
        if (result.reason === "max-steps") notice("Stopped: step limit reached. Send a message to continue.", "warn");
        if (result.reason === "aborted") notice("Cancelled.", "warn");
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          notice("Not signed in. Use /login or run `deyin login` in another terminal.", "error");
        } else {
          notice(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
      } finally {
        setRunning(false);
        setActiveTool(null);
        setStreamText("");
        setStreamReasoning("");
        abortRef.current = null;
      }
    },
    [agentDef, ctx, handleEvent, model, modelList, notice, pushItem, requestPermission],
  );

  const openPicker = useCallback(
    (kind: PickerState["kind"]): void => {
      if (kind === "model") {
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
    [ctx.config, ctx.sessions, modelList],
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
    const token = await tokenSource(ctx)();
    if (!token) {
      notice("Not signed in.", "error");
      return;
    }
    const beforeTokens = estimateTokens(messagesRef.current);
    notice("Compacting conversation\u2026");
    try {
      const compacted = await compactWithModel({
        apiBaseUrl: ctx.config.apiBaseUrl,
        token,
        model,
        messages: messagesRef.current,
      });
      if (compacted === messagesRef.current) {
        notice("Nothing older than the recent tail to compact yet.", "warn");
        return;
      }
      messagesRef.current = compacted;
      const meta = ctx.sessions.create({ cwd: ctx.cwd, model, agent: agentName });
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
      setModelList(await listModels(ctx.config, tokenSource(ctx)));
    } catch (err) {
      notice(`Login failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [ctx, notice]);

  const handleSlash = useCallback(
    (text: string): void => {
      const command = text.split(/\s+/)[0] ?? "";
      switch (command) {
        case "/help":
          notice(SLASH_COMMANDS.map((c) => `${c.name.padEnd(11)} ${c.description}`).join("\n"));
          break;
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
    [ctx.usage, doCompact, doLogin, exit, notice, openPicker, pushItem],
  );

  const handleSubmit = useCallback(
    (raw: string): void => {
      const text = raw.trim();
      setInput("");
      if (!text) return;
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
    [handleSlash, notice, running, startRun],
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
        active={!permission && !picker && !question}
        history={historyRef.current}
        placeholder={running ? "running\u2026 esc to cancel" : 'Ask anything \u00b7 "/" for commands'}
      />

      {updateLine ? <Text color="yellow">{updateLine}</Text> : null}
      <Box justifyContent="space-between">
        <Text dimColor>{`${model} \u00b7 ${agentName} \u00b7 ${shortenPath(ctx.cwd)} \u00b7 ${userLabel ?? "signed out"}`}</Text>
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
