/**
 * WebSocket message protocol between the Deyin web client and its host-server.
 * Request/response calls carry a numeric `id`; terminal streams are pushed.
 *
 * The host-facing shapes come from @deyin/host-core (the same types the desktop contract
 * uses), so the browser transport satisfies the desktop `DeyinApi` by construction.
 */
import type { AgentEventEnvelope, EnvInfo, FileNode, ProviderApiFormat, TerminalCreateOptions } from "@deyin/host-core/shared";

export type { EnvInfo, FileNode, ShellInfo, TerminalCreateOptions } from "@deyin/host-core/shared";
export type { AgentEventEnvelope } from "@deyin/host-core/shared";

/** Provider routing the agent uses server-side; the API key lives only in this message. */
export interface WebAgentProviderRouting {
  baseUrl: string;
  /** Empty string for keyless local endpoints (Ollama). */
  token: string;
  apiFormat: ProviderApiFormat;
  authHeader?: boolean;
}

export type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "files.tree"; id: number; dir?: string }
  | { type: "files.read"; id: number; path: string }
  | { type: "files.write"; id: number; path: string; content: string }
  | { type: "env.detect"; id: number }
  | {
      type: "agent.start";
      id: number;
      threadId: string;
      prompt: string;
      model: string;
      thinking: boolean;
      approvalMode: "full-access" | "ask-first" | "read-only";
      mode: "agent" | "plan" | "ask" | "delivery";
      history: { role: "user" | "assistant"; content: string }[];
      provider: WebAgentProviderRouting;
    }
  | { type: "agent.stop"; threadId: string }
  | { type: "agent.approve"; requestId: string; decision: "allow" | "allow-always" | "deny" }
  | { type: "agent.answer"; requestId: string; answers: Record<string, string | string[]> }
  | { type: "term.create"; id: number; opts: TerminalCreateOptions }
  | { type: "term.attach"; id: number; termId: string }
  | { type: "term.write"; termId: string; data: string }
  | { type: "term.resize"; termId: string; cols: number; rows: number }
  | { type: "term.kill"; termId: string };

export type ServerMessage =
  | { type: "auth.ok"; user: { sub: string; email?: string; name?: string; plan?: string }; workspaceRoot: string }
  | { type: "auth.err"; message: string }
  | { type: "reply"; id: number; ok: true; result: unknown }
  | { type: "reply"; id: number; ok: false; error: string }
  | { type: "term.data"; termId: string; data: string }
  | { type: "term.exit"; termId: string; exitCode: number }
  | { type: "agent.event"; envelope: AgentEventEnvelope };

export interface FilesTreeResult {
  nodes: FileNode[];
}
export interface FilesReadResult {
  content: string;
}
export interface FilesWriteResult {
  ok: true;
}
export interface TermCreateResult {
  termId: string;
}
export interface TermAttachResult {
  scrollback: string;
}
export interface EnvDetectResult {
  env: EnvInfo;
}
