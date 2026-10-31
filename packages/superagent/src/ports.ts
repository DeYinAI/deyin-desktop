/** Ports the host implements: the agent loop, the git workspace, and secrets. Everything else in the package is host-agnostic. */
import type { ModelRef } from "./settings.js";

/** A tool the model can call; `parameters` is JSON Schema, `execute` throws to report an error to the model. */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface AgentRunRequest {
  role: "orchestrator" | "worker";
  /** Stable conversation id (the orchestrator's, or one per ticket): the host keeps and compacts its history between runs. */
  sessionId: string;
  systemPrompt: string;
  /** Domain tools, in addition to the host's own file and shell tools for a worker. */
  tools: readonly AgentTool[];
  /** A worker's ticket directory; an orchestrator has none and no file or shell tools. */
  cwd?: string;
  /** Environment variables for the worker's shell; carries credentials, so never log it. */
  env: Readonly<Record<string, string>>;
  /** Commands a worker's shell must refuse. */
  blockedCommands: readonly string[];
  model: ModelRef | null;
  /** The messages this run starts with, each a user turn. */
  messages: readonly string[];
  /** Messages that arrived while the run was active; asked between model steps, a returned message joins the conversation. */
  drain(): string[];
  signal: AbortSignal;
}

/** A runner failure; `retryable` is false for one a repeat cannot fix, such as a missing model or an invalid key. */
export class AgentRunError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = "AgentRunError";
  }
}

export interface AgentRunResult {
  /** The model's last words, which may be empty. */
  finalText: string;
}

export interface AgentRunner {
  /** Runs until the model stops calling tools and `drain()` yields nothing. Rejects on a model or runtime failure. */
  run(request: AgentRunRequest): Promise<AgentRunResult>;
  /** Drops a conversation's stored history, for a reset. */
  forget(sessionId: string): Promise<void>;
}

export interface PrepareInput {
  name: string;
  /** The ticket's directory; it must not exist yet unless a previous prepare created it. */
  directory: string;
  branch: string;
  /** The watched repository, as owner/name. */
  repository: string;
  /** A local checkout to add the worktree to; empty for the managed clone. */
  checkout: string;
  /** Credentials for git over https (never log); the same environment the worker's shell gets. */
  env: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface Workspace {
  /** Creates the ticket's worktree on a fresh branch from the repository's default branch; repeating it for a ready worktree changes nothing. */
  prepare(input: PrepareInput): Promise<void>;
  /** Removes a ticket's worktree; best effort. */
  remove(input: { directory: string }): Promise<void>;
}

export interface Secrets {
  /** The agent account's GitHub token, or `undefined` when none is stored. */
  githubToken(): string | undefined;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}
