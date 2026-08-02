/** One tool invocation requested by the model (arguments is the raw JSON string). */
import type { FileMutationRequest } from "./tools/file-mutation.js";

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Transcript message. A superset of host-core's ChatMessage: assistant messages can
 * carry tool calls, and tool messages carry the result of one call.
 */
export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; reasoning?: string; toolCalls?: AgentToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Provider prompt-cache hits (OpenAI cached_tokens / Anthropic cache_read). */
  cachedPromptTokens?: number;
}

/** JSON Schema for a tool's parameters (OpenAI function-calling format). */
export interface ToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** OpenAI wire format for a tool declaration. */
export interface WireTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolSchema;
  };
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  /** Delivery mode: how to verify this step before complete_step sign-off. */
  acceptanceCriteria?: string;
  /** Set when complete_step records a sign-off for this id. */
  signedOff?: boolean;
  signOffNotes?: string;
}

/** A workspace file mutation reported by the write/edit tools (drives diff UIs). */
export interface FileChange {
  path: string;
  /** Content before the change; empty string for newly created files. */
  before: string;
  after: string;
}

/** Host-injected persistent shell used by the bash tool when available. */
export interface ToolShell {
  run(
    command: string,
    opts: {
      cwd?: string;
      timeoutS: number;
      signal?: AbortSignal;
      onData?: (delta: string) => void;
    },
  ): Promise<{ output: string; exitCode: number | null }>;
}

/** Ambient state passed to every tool execution in one agent run. */
export interface ToolContext {
  /** Workspace root; all relative tool paths resolve against this. */
  cwd: string;
  signal?: AbortSignal;
  /** Shared todo list, rendered by the todo_write tool. */
  todos: TodoItem[];
  onTodosChanged?: (todos: TodoItem[]) => void;
  /** Fired by write/edit after a successful file mutation. */
  onFileChanged?: (change: FileChange) => void;
  /**
   * Optional host-backed persistent shell (PTY). When set, bash uses it instead
   * of a one-shot spawn so cwd/env persist and output can stream live.
   */
  shell?: ToolShell;
  /**
   * Per-call callback bound by the loop: tools that produce incremental output
   * (bash) call this to emit `tool-delta` events while still running.
   */
  onOutput?: (delta: string) => void;
  /** Host bridge for structured user-input tools (AskQuestion). */
  resolveInteraction?: (request: InteractionRequest) => Promise<string>;
  /** Fired when create_plan writes a plan artifact. */
  onPlanCreated?: (plan: PlanArtifact) => void;
  /** Host bridge for EnterPlanMode / ExitPlanMode / SwitchMode. */
  onModeChange?: (change: ModeChangeRequest) => Promise<string>;
  /** Skills discovered for this run (Skill tool). */
  skills?: DiscoveredSkill[];
  /** Session metadata for read_session_context. */
  sessionMeta?: ToolSessionMeta;
  /** Transcript snapshot for read_session_context (read-only). */
  messages?: readonly AgentMessage[];
  /** Inter-agent messaging bus (SendMessage tool). */
  sendMessage?: (to: string, content: string) => Promise<string>;
  /** Poll a background shell task started earlier in this session. */
  pollBackgroundTask?: (taskId: string, blockUntilMs: number) => Promise<string>;
  /** Register a detached background shell task (bash with block_until_ms=0). */
  registerBackgroundTask?: (
    taskId: string,
    promise: Promise<{ output: string; exitCode: number | null }>,
  ) => void;
  /**
   * When set, write/edit/delete route through review instead of applying immediately.
   * Resolves when the user approves (file written + onFileChanged fired) or rejects.
   */
  applyFileChange?: (change: FileMutationRequest) => Promise<"applied" | "rejected">;
  /** Goal mode: fired when the model calls report_goal_met. */
  onGoalReport?: (report: { met: boolean; reason: string }) => void;
  /** Active goal text when the thread is in goal mode. */
  goalText?: string;
  /** Delivery mode evidence ledger (session-scoped). */
  evidenceLedger?: import("./evidence/ledger.js").EvidenceLedger;
  /** Fired when complete_step records a sign-off. */
  onEvidenceSignOff?: (receipt: {
    stepId: string;
    verificationCommand: string;
    diffSummary: string;
    reviewNotes?: string;
  }) => void;
  /** When true, mutation/finalization readiness gates are enforced. */
  evidenceGatesEnabled?: boolean;
  /** Session-scoped subagent scheduler for task/fleet coordination. */
  scheduler?: import("./scheduler/subagent-scheduler.js").SubagentScheduler;
  /** Session-scoped background job registry. */
  jobsManager?: import("./jobs/manager.js").JobsManager;
  /** Register a background job and return its id. */
  registerBackgroundJob?: (job: {
    kind: string;
    label: string;
    profile?: string;
    prompt: string;
    run: (signal?: AbortSignal) => Promise<string>;
  }) => string;
  /** Wait for background jobs to complete. */
  waitForJobs?: (
    jobIds: string[],
    timeoutMs: number,
  ) => Promise<
    Array<{
      id: string;
      label: string;
      status: string;
      result?: string;
      error?: string;
    }>
  >;
  /** Reserve parent write paths during write/edit execution. */
  reserveParentWrite?: (paths: string[]) => () => void;
}

/** Coarse capability class used for default permissions. */
export type ToolPermissionTier = "read" | "write" | "execute" | "interaction";

export interface AskQuestionOption {
  id: string;
  label: string;
}

export interface AskQuestionItem {
  id: string;
  prompt: string;
  options: AskQuestionOption[];
  allow_multiple?: boolean;
}

/** Structured user-input requests (AskQuestion, etc.). */
export type InteractionRequest =
  | { type: "ask-question"; questions: AskQuestionItem[]; title?: string };

export interface ModeChangeRequest {
  target: "agent" | "plan" | "ask" | "delivery";
  previous?: "agent" | "plan" | "ask" | "delivery";
  userApproved?: boolean;
  explanation?: string;
  event: "enter" | "exit" | "switch";
}

export interface PlanArtifact {
  name: string;
  overview?: string;
  plan: string;
  filePath?: string;
  todos?: TodoItem[];
}

export interface DiscoveredSkill {
  name: string;
  path: string;
  description?: string;
}

export interface ToolSessionMeta {
  threadId?: string;
  mode?: string;
  approvalMode?: string;
  model?: string;
  cwd?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolSchema;
  /** read tools are auto-allowed by default; write/execute default to "ask". */
  tier: ToolPermissionTier;
  /** One-line human summary of a call, shown in permission prompts and tool cards. */
  summarize(args: Record<string, unknown>): string;
  /** Returns the tool result text (fed back to the model as a role:"tool" message). */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** Thrown by the loop when no valid access token is available. */
export class AuthRequiredError extends Error {
  constructor(message = "Not signed in. Run `deyin login` first.") {
    super(message);
    this.name = "AuthRequiredError";
  }
}
