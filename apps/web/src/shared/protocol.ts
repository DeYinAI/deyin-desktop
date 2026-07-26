/**
 * WebSocket message protocol between the Deyin web client and its host-server.
 * Request/response calls carry a numeric `id`; terminal streams are pushed.
 *
 * The host-facing shapes are defined here (not imported from the desktop contract) so the
 * server compiles in isolation. They are structurally identical to the desktop types, so
 * the browser transport still satisfies the desktop `DeyinApi`.
 */
export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

export interface TerminalCreateOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

export interface ShellInfo {
  id: string;
  label: string;
  path: string;
  args?: string[];
  kind: "wsl" | "posix" | "windows";
}

export interface EnvInfo {
  platform: string;
  arch: string;
  wsl2: boolean;
  wslDistros: string[];
  shells: ShellInfo[];
  defaultShell: string;
  hostname: string;
}

export type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "files.tree"; id: number; dir?: string }
  | { type: "files.read"; id: number; path: string }
  | { type: "env.detect"; id: number }
  | { type: "term.create"; id: number; opts: TerminalCreateOptions }
  | { type: "term.write"; termId: string; data: string }
  | { type: "term.resize"; termId: string; cols: number; rows: number }
  | { type: "term.kill"; termId: string };

export type ServerMessage =
  | { type: "auth.ok"; user: { sub: string; email?: string; name?: string; plan?: string } }
  | { type: "auth.err"; message: string }
  | { type: "reply"; id: number; ok: true; result: unknown }
  | { type: "reply"; id: number; ok: false; error: string }
  | { type: "term.data"; termId: string; data: string }
  | { type: "term.exit"; termId: string; exitCode: number };

export interface FilesTreeResult {
  nodes: FileNode[];
}
export interface FilesReadResult {
  content: string;
}
export interface TermCreateResult {
  termId: string;
}
export interface EnvDetectResult {
  env: EnvInfo;
}
