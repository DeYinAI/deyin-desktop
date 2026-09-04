/**
 * WebSocket message protocol between the Deyin web client and its host-server.
 * Request/response calls carry a numeric `id`; terminal streams are pushed.
 *
 * The host-facing shapes come from @deyin/host-core (the same types the desktop contract
 * uses), so the browser transport satisfies the desktop `DeyinApi` by construction.
 */
import type {
  AgentEventEnvelope,
  AgentImageInput,
  AgentTodoItem,
  EnvInfo,
  FileNode,
  ProviderApiFormat,
  ReasoningEffort,
  TerminalCreateOptions,
} from "@deyin/host-core/shared";

export type { EnvInfo, FileNode, ShellInfo, TerminalCreateOptions } from "@deyin/host-core/shared";
export type { AgentEventEnvelope, AgentImageInput, AgentTodoItem } from "@deyin/host-core/shared";

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
  /** Generic git RPC: `op` names a @deyin/host-core git service method. */
  | { type: "git.call"; id: number; op: string; args: unknown[] }
  | { type: "repo.connect"; id: number; url: string; token?: string; branch?: string }
  | { type: "repo.state"; id: number }
  | { type: "repo.ship"; id: number; message?: string }
  | {
      type: "agent.start";
      id: number;
      threadId: string;
      prompt: string;
      model: string;
      thinking: boolean;
      effort?: ReasoningEffort;
      approvalMode: "full-access" | "ask-first" | "read-only";
      mode: "agent" | "plan" | "ask" | "delivery";
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
      /** Must match the renderer's active run id (stale-event filtering). */
      runId?: string;
      /** Model context window in tokens (from the client catalog). */
      contextLength?: number;
      /** Capability ids the user disabled in settings. */
      disabledCaps?: string[];
    }
  | { type: "agent.stop"; threadId: string }
  | { type: "agent.resetSession"; id: number; threadId: string }
  | { type: "agent.disposeShell"; threadId: string }
  | { type: "agent.approve"; requestId: string; decision: "allow" | "allow-always" | "deny" }
  | { type: "agent.answer"; requestId: string; answers: Record<string, string | string[]> }
  | {
      type: "checkpoints.revertRun";
      id: number;
      threadId: string;
      checkpointId: string;
    }
  | {
      type: "checkpoints.revertFile";
      id: number;
      threadId: string;
      checkpointId: string;
      path: string;
    }
  | {
      type: "checkpoints.revertAfterEvent";
      id: number;
      threadId: string;
      eventIndex: number;
      checkpointIds: string[];
    }
  | { type: "term.create"; id: number; opts: TerminalCreateOptions }
  | { type: "term.attach"; id: number; termId: string }
  | { type: "term.write"; termId: string; data: string }
  | { type: "term.resize"; termId: string; cols: number; rows: number }
  | { type: "term.kill"; termId: string }
  | { type: "images.save"; id: number; threadId: string; base64: string; mediaType?: string }
  | { type: "images.read"; id: number; threadId: string; file: string }
  | { type: "visualize.read"; id: number; threadId: string; file: string }
  | { type: "page.read"; id: number; threadId: string; file: string }
  | {
      type: "images.generate";
      id: number;
      threadId: string;
      prompt: string;
      model: string;
      size?: string;
      n?: number;
      negativePrompt?: string;
      numSteps?: number;
      guidance?: number;
      seed?: number;
      strength?: number;
      provider: WebAgentProviderRouting;
    }
  | { type: "videos.save"; id: number; threadId: string; base64: string; mediaType?: string }
  | { type: "videos.read"; id: number; threadId: string; file: string }
  | {
      type: "videos.generate";
      id: number;
      threadId: string;
      prompt: string;
      model: string;
      aspectRatio?: string;
      seconds?: number;
      size?: string;
      seed?: number;
      mode?: string;
      inputImages?: AgentImageInput[];
      provider: WebAgentProviderRouting;
    };

export type ServerMessage =
  | { type: "auth.ok"; user: { sub: string; email?: string; name?: string; plan?: string }; workspaceRoot: string }
  | { type: "auth.err"; message: string }
  | { type: "reply"; id: number; ok: true; result: unknown }
  | { type: "reply"; id: number; ok: false; error: string }
  | { type: "term.data"; termId: string; data: string }
  | { type: "term.exit"; termId: string; exitCode: number }
  | { type: "agent.event"; envelope: AgentEventEnvelope }
  /** Pushed when the sandbox repo's git state changed (watcher or completed op). */
  | { type: "git.changed" }
  /** Streaming progress for repo connect (clone/checkout) and ship operations. */
  | { type: "repo.progress"; stage: "clone" | "connect" | "ship"; line: string };

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

export interface ImagesSaveResult {
  file: string;
}
export interface ImagesReadResult {
  /** `data:` URL, ready for an <img src>. */
  dataUrl: string;
}

export type { RepoStateResult, RepoShipResult, RepoProgressStage, RepoProgressEvent } from "./types.js";
export type { ImageGenerateRequest, ImageGenerateResult, GeneratedImageInfo, VideoGenerateRequest, VideoGenerateResult, GeneratedVideoInfo } from "./types.js";
