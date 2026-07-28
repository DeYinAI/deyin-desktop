/** One tool invocation requested by the model (arguments is the raw JSON string). */
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
}

/** Ambient state passed to every tool execution in one agent run. */
export interface ToolContext {
  /** Workspace root; all relative tool paths resolve against this. */
  cwd: string;
  signal?: AbortSignal;
  /** Shared todo list, rendered by the todo_write tool. */
  todos: TodoItem[];
  onTodosChanged?: (todos: TodoItem[]) => void;
}

/** Coarse capability class used for default permissions. */
export type ToolPermissionTier = "read" | "write" | "execute";

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
