import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import type {
  AgentUiEvent,
  BotElicitationRequest,
  ExternalAgentDescriptor,
} from "@deyin/contract";
import {
  fastFrameAcpChunk,
  fastFrameNdjsonChunk,
  fastRingBufferAppend,
  fastRingBufferGetLines,
  fastWatchdogCheck,
  fastWatchdogHeartbeat,
  fastWatchdogRegister,
  fastWatchdogUnregister,
} from "@deyin/agent-core";
import { ExternalAgentDetector } from "./detector.js";
import { killProcessTree } from "./tree-kill.js";

export interface ExternalRunOptions {
  runId?: string;
  agentId: string;
  prompt: string;
  cwd: string;
  model?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stallThresholdMs?: number;
  logBufferId?: string;
  onEvent?: (event: AgentUiEvent) => void;
  onRawLine?: (line: string) => void;
  onElicitation?: (request: BotElicitationRequest) => Promise<string>;
  onStall?: (inactiveMs: number) => void;
  signal?: AbortSignal;
}

/** Parses polymorphic line events from Claude Code, OpenAI Codex, OpenCode, and generic CLI tools. */
export function parseCliEvent(parsed: any): {
  delta?: string;
  finalText?: string;
  toolInfo?: { name: string; summary: string };
  error?: string;
} {
  if (!parsed || typeof parsed !== "object") return {};

  // 1. Claude Code stream-json
  if (parsed.type === "stream_event" && parsed.event) {
    const ev = parsed.event;
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      return { delta: ev.delta.text };
    }
  }
  if (parsed.type === "result") {
    if (typeof parsed.result === "string") return { finalText: parsed.result };
    if (typeof parsed.text === "string") return { finalText: parsed.text };
  }
  if (parsed.type === "assistant_response" && parsed.message?.content) {
    const textBlocks = Array.isArray(parsed.message.content)
      ? parsed.message.content
          .filter((b: any) => b.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("")
      : "";
    if (textBlocks) return { finalText: textBlocks };
  }

  // 2. OpenAI Codex CLI exec --json
  if (parsed.type === "item.completed" && parsed.item) {
    if (parsed.item.type === "agent_message" && typeof parsed.item.text === "string") {
      return { finalText: parsed.item.text, delta: parsed.item.text };
    }
    if (parsed.item.type === "command_execution") {
      return { toolInfo: { name: "bash", summary: parsed.item.command ?? "executed shell command" } };
    }
  }
  if (parsed.type === "item.started" && parsed.item?.type === "command_execution") {
    return { toolInfo: { name: "bash", summary: parsed.item.command ?? "running command" } };
  }
  if (parsed.type === "turn.failed" && parsed.error?.message) {
    return { error: parsed.error.message };
  }

  // 3. OpenCode & generic NDJSON shapes
  if (typeof parsed.delta === "string") {
    return { delta: parsed.delta };
  }
  if (typeof parsed.text === "string") {
    return { delta: parsed.text, finalText: parsed.text };
  }
  if (typeof parsed.content === "string") {
    return { delta: parsed.content, finalText: parsed.content };
  }
  if (typeof parsed.result === "string") {
    return { finalText: parsed.result };
  }

  return {};
}

export interface ActiveRun {
  runId: string;
  agentId: string;
  child: ChildProcess;
  startedAt: number;
  timeoutMs: number;
  stallThresholdMs: number;
  watchdogTimer?: NodeJS.Timeout;
  options?: ExternalRunOptions;
}

export class ExternalAgentService {
  private activeRuns = new Map<string, ActiveRun>();
  readonly detector: ExternalAgentDetector;

  constructor(detector?: ExternalAgentDetector) {
    this.detector = detector ?? new ExternalAgentDetector();
  }

  listAgents(forceRefresh = false): Promise<ExternalAgentDescriptor[]> {
    return this.detector.detectAll(forceRefresh);
  }

  testAgent(agentId: string) {
    return this.detector.testAgent(agentId);
  }

  getRecentLogs(runId: string, maxLines = 100): string[] {
    const direct = fastRingBufferGetLines(runId, maxLines);
    if (direct.length > 0) return direct;
    for (const [id, run] of this.activeRuns.entries()) {
      if (id.startsWith(`${runId}-`) || run.options?.logBufferId === runId) {
        const childLines = fastRingBufferGetLines(id, maxLines);
        if (childLines.length > 0) return childLines;
      }
    }
    return [];
  }

  async runAgent(options: ExternalRunOptions): Promise<{ ok: boolean; error?: string; outputText: string; runId: string }> {
    const agents = await this.listAgents();
    const agent = agents.find((a) => a.id === options.agentId);
    if (!agent || !agent.installed || !agent.path) {
      throw new Error(`External agent '${options.agentId}' is not installed or detected.`);
    }

    const runId = options.runId ?? options.logBufferId ?? randomUUID();
    const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000; // 15 min default
    const stallThresholdMs = options.stallThresholdMs ?? 2 * 60 * 1000; // 2 min default

    if (agent.protocol === "acp") {
      return this.runAcpAgent(runId, agent, options, timeoutMs, stallThresholdMs);
    } else {
      return this.runHeadlessCli(runId, agent, options, timeoutMs, stallThresholdMs);
    }
  }

  abortRun(runId: string): boolean {
    let active = this.activeRuns.get(runId);
    let targetId = runId;
    if (!active) {
      for (const [id, run] of this.activeRuns.entries()) {
        if (id.startsWith(`${runId}-`) || run.options?.logBufferId === runId) {
          active = run;
          targetId = id;
          break;
        }
      }
    }
    if (!active) return false;
    this.cleanupRun(targetId);
    if (active.child.pid) {
      killProcessTree(active.child.pid);
    }
    return true;
  }

  nudgeRun(runId: string, message = "Status check: please report progress or next step."): boolean {
    let active = this.activeRuns.get(runId);
    let targetId = runId;
    if (!active) {
      for (const [id, run] of this.activeRuns.entries()) {
        if (id.startsWith(`${runId}-`) || run.options?.logBufferId === runId) {
          active = run;
          targetId = id;
          break;
        }
      }
    }
    if (!active || !active.child.stdin || active.child.stdin.destroyed) return false;
    try {
      active.child.stdin.write(`${message}\n`);
      fastWatchdogHeartbeat(targetId);
      return true;
    } catch {
      return false;
    }
  }

  private setupWatchdog(
    runId: string,
    pid: number,
    timeoutMs: number,
    stallThresholdMs: number,
    onStall?: (inactiveMs: number) => void,
    onTimeout?: () => void,
  ): NodeJS.Timeout {
    fastWatchdogRegister(runId, pid, timeoutMs, stallThresholdMs, Date.now());

    let isStalled = false;
    let timedOut = false;

    const timer = setInterval(() => {
      const check = fastWatchdogCheck(runId, Date.now());
      if (check.status === "stalled") {
        if (!isStalled) {
          isStalled = true;
          onStall?.(check.inactiveMs);
        }
      } else if (check.status === "timed-out") {
        if (!timedOut) {
          timedOut = true;
          onTimeout?.();
        }
      } else if (check.status === "ok") {
        isStalled = false;
      }
    }, 5000);

    return timer;
  }

  private cleanupRun(runId: string): void {
    const active = this.activeRuns.get(runId);
    if (active?.watchdogTimer) {
      clearInterval(active.watchdogTimer);
    }
    fastWatchdogUnregister(runId);
    fastRingBufferClear(runId);
    this.activeRuns.delete(runId);
  }

  private runHeadlessCli(
    runId: string,
    agent: ExternalAgentDescriptor,
    options: ExternalRunOptions,
    timeoutMs: number,
    stallThresholdMs: number,
  ): Promise<{ ok: boolean; error?: string; outputText: string; runId: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (res: { ok: boolean; error?: string; outputText: string; runId: string }) => {
        if (settled) return;
        settled = true;
        this.cleanupRun(runId);
        resolve(res);
      };

      const args: string[] = [];
      const isWin = platform() === "win32";

      if (agent.id === "claude") {
        args.push("-p", options.prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages");
        if (options.model) args.push("--model", options.model);
      } else if (agent.id === "codex") {
        args.push("exec", "--json", options.prompt);
        if (options.model) args.push("-m", options.model);
        args.push("--sandbox", "workspace-write");
      } else if (agent.id === "opencode") {
        args.push("run", "--json", options.prompt);
        if (options.model) args.push("-m", options.model);
      } else {
        // Fallback generic invocation
        args.push(options.prompt);
      }

      let child: ChildProcess;
      try {
        child = spawn(agent.path!, args, {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          detached: !isWin,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err: any) {
        return settle({ ok: false, error: `Failed to spawn ${agent.name}: ${err.message}`, outputText: "", runId });
      }

      let stdoutRemainder = "";
      let collectedOutput = "";

      const appendToLogs = (line: string) => {
        fastRingBufferAppend(runId, line);
        if (options.logBufferId && options.logBufferId !== runId) {
          fastRingBufferAppend(options.logBufferId, line);
        }
      };

      const active: ActiveRun = {
        runId,
        agentId: agent.id,
        child,
        startedAt: Date.now(),
        timeoutMs,
        stallThresholdMs,
        options,
      };
      this.activeRuns.set(runId, active);

      if (child.pid) {
        active.watchdogTimer = this.setupWatchdog(
          runId,
          child.pid,
          timeoutMs,
          stallThresholdMs,
          options.onStall,
          () => {
            this.abortRun(runId);
            settle({ ok: false, error: `Process timed out after ${Math.round(timeoutMs / 1000)}s`, outputText: collectedOutput, runId });
          },
        );
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        fastWatchdogHeartbeat(runId);
        const text = chunk.toString("utf8");
        const framed = fastFrameNdjsonChunk(stdoutRemainder, text);
        stdoutRemainder = framed.rest;

        for (const line of framed.lines) {
          appendToLogs(line);
          options.onRawLine?.(line);
          try {
            const parsed = JSON.parse(line);
            const { delta, finalText, toolInfo, error: eventErr } = parseCliEvent(parsed);
            if (eventErr) {
              options.onEvent?.({ type: "error", text: eventErr });
              collectedOutput += `\nError: ${eventErr}`;
            }
            if (toolInfo) {
              options.onEvent?.({
                type: "tool-start",
                callId: randomUUID(),
                name: toolInfo.name,
                summary: toolInfo.summary,
              });
            }
            if (delta) {
              collectedOutput += delta;
              options.onEvent?.({ type: "text-delta", delta });
            } else if (finalText) {
              collectedOutput = finalText;
            }
          } catch {
            collectedOutput += line + "\n";
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        fastWatchdogHeartbeat(runId);
        const errText = chunk.toString("utf8");
        appendToLogs(`[stderr] ${errText.trim()}`);
        options.onRawLine?.(errText);
      });

      child.on("close", (code) => {
        if (code === 0) {
          options.onEvent?.({ type: "done", reason: "completed", finalText: collectedOutput });
          settle({ ok: true, outputText: collectedOutput, runId });
        } else {
          settle({ ok: false, error: `Process exited with code ${code}`, outputText: collectedOutput, runId });
        }
      });

      child.on("error", (err) => {
        settle({ ok: false, error: err.message, outputText: collectedOutput, runId });
      });

      options.signal?.addEventListener("abort", () => {
        this.abortRun(runId);
        settle({ ok: false, error: "Aborted by user", outputText: collectedOutput, runId });
      });
    });
  }

  private runAcpAgent(
    runId: string,
    agent: ExternalAgentDescriptor,
    options: ExternalRunOptions,
    timeoutMs: number,
    stallThresholdMs: number,
  ): Promise<{ ok: boolean; error?: string; outputText: string; runId: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (res: { ok: boolean; error?: string; outputText: string; runId: string }) => {
        if (settled) return;
        settled = true;
        this.cleanupRun(runId);
        resolve(res);
      };

      const isWin = platform() === "win32";
      const args: string[] = [];

      if (agent.id === "opencode") {
        args.push("acp");
      } else if (agent.id === "zcode" && agent.binaryName === "zcode") {
        args.push("app-server", "--stdio");
      }

      let child: ChildProcess;
      try {
        child = spawn(agent.path!, args, {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          detached: !isWin,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err: any) {
        return settle({ ok: false, error: `Failed to spawn ACP agent ${agent.name}: ${err.message}`, outputText: "", runId });
      }

      let stdoutRemainder = "";
      let collectedOutput = "";
      let rpcIdCounter = 1;
      let currentSessionId: string | undefined;
      const pendingRpc = new Map<number, string>();

      const appendToLogs = (line: string) => {
        fastRingBufferAppend(runId, line);
        if (options.logBufferId && options.logBufferId !== runId) {
          fastRingBufferAppend(options.logBufferId, line);
        }
      };

      const active: ActiveRun = {
        runId,
        agentId: agent.id,
        child,
        startedAt: Date.now(),
        timeoutMs,
        stallThresholdMs,
        options,
      };
      this.activeRuns.set(runId, active);

      const sendRpc = (method: string, params?: Record<string, unknown>): number => {
        const id = rpcIdCounter++;
        pendingRpc.set(id, method);
        const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n";
        child.stdin?.write(msg);
        return id;
      };

      if (child.pid) {
        active.watchdogTimer = this.setupWatchdog(
          runId,
          child.pid,
          timeoutMs,
          stallThresholdMs,
          options.onStall,
          () => {
            this.abortRun(runId);
            settle({ ok: false, error: `ACP agent timed out after ${Math.round(timeoutMs / 1000)}s`, outputText: collectedOutput, runId });
          },
        );
      }

      // Step 1: Send ACP initialize
      sendRpc("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        fastWatchdogHeartbeat(runId);
        const text = chunk.toString("utf8");
        const framed = fastFrameAcpChunk(stdoutRemainder, text);
        stdoutRemainder = framed.rest;

        for (const line of framed.payloads) {
          appendToLogs(line);
          options.onRawLine?.(line);

          try {
            const msg = JSON.parse(line);

            // Handle errors from server immediately to prevent hangs
            if (msg.error) {
              const errMsg = msg.error.message || `ACP JSON-RPC error (${msg.error.code ?? "unknown"})`;
              options.onEvent?.({ type: "error", text: errMsg });
              if (child.pid) killProcessTree(child.pid);
              return settle({ ok: false, error: errMsg, outputText: collectedOutput, runId });
            }

            // Handling ACP notifications
            if (msg.method === "session/update" && msg.params) {
              const p = msg.params;
              const delta =
                typeof p.delta === "string"
                  ? p.delta
                  : p.update?.type === "agent_message_delta" && typeof p.update.delta?.text === "string"
                    ? p.update.delta.text
                    : undefined;

              if (delta) {
                collectedOutput += delta;
                options.onEvent?.({ type: "text-delta", delta });
              }

              const toolCall = p.toolCall ?? (p.update?.type === "tool_call" ? p.update.toolCall : undefined);
              if (toolCall) {
                options.onEvent?.({
                  type: "tool-start",
                  callId: toolCall.id ?? randomUUID(),
                  name: toolCall.name ?? "external-tool",
                  summary: toolCall.summary ?? "",
                });
              }
            } else if (msg.method === "session/requestDecision" || msg.method === "session/elicitInput") {
              // Interactive elicitation from external agent
              if (options.onElicitation) {
                const elicitReq: BotElicitationRequest = {
                  id: String(msg.id),
                  stageId: runId,
                  agentId: agent.id,
                  prompt: msg.params?.prompt ?? "External agent requested user input.",
                  options: msg.params?.options,
                };
                options.onElicitation(elicitReq)
                  .then((answer) => {
                    const resp = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { answer } }) + "\n";
                    child.stdin?.write(resp);
                  })
                  .catch((err) => {
                    const errResp = JSON.stringify({
                      jsonrpc: "2.0",
                      id: msg.id,
                      error: { code: -32000, message: err?.message || "Elicitation rejected" }
                    }) + "\n";
                    child.stdin?.write(errResp);
                  });
              } else {
                const errResp = JSON.stringify({
                  jsonrpc: "2.0",
                  id: msg.id,
                  error: { code: -32000, message: "Elicitation requested but no handler wired in non-interactive session" }
                }) + "\n";
                child.stdin?.write(errResp);
              }
            } else if (msg.id != null) {
              const method = pendingRpc.get(msg.id);
              pendingRpc.delete(msg.id);

              if (method === "initialize") {
                // Initialize completed -> create session
                sendRpc("session/new", { cwd: options.cwd, model: options.model });
              } else if (method === "session/new") {
                // Session created -> store sessionId and send prompt
                currentSessionId = msg.result?.sessionId ?? (typeof msg.result === "string" ? msg.result : undefined);
                sendRpc("session/prompt", {
                  sessionId: currentSessionId,
                  prompt: options.prompt,
                });
              } else if (method === "session/prompt") {
                // Prompt completed!
                const final =
                  collectedOutput ||
                  (typeof msg.result?.text === "string"
                    ? msg.result.text
                    : typeof msg.result?.output === "string"
                      ? msg.result.output
                      : JSON.stringify(msg.result ?? ""));
                settle({ ok: true, outputText: final, runId });
              }
            }
          } catch {}
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        fastWatchdogHeartbeat(runId);
        const errText = chunk.toString("utf8");
        appendToLogs(`[stderr] ${errText.trim()}`);
      });

      child.on("close", (code) => {
        if (code === 0) {
          settle({ ok: true, outputText: collectedOutput, runId });
        } else {
          settle({ ok: false, error: `ACP process exited with code ${code}`, outputText: collectedOutput, runId });
        }
      });

      child.on("error", (err) => {
        settle({ ok: false, error: err.message, outputText: collectedOutput, runId });
      });

      options.signal?.addEventListener("abort", () => {
        this.abortRun(runId);
        settle({ ok: false, error: "Aborted by user", outputText: collectedOutput, runId });
      });
    });
  }
}
