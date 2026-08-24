import type { DirectoryEntry, FileNode, WorkspaceLocation } from "../types.js";

/** Host-side filesystem + workspace operations for local or remote workspaces. */
export interface HostBackend {
  readonly location: WorkspaceLocation;
  readonly displayRoot: string;
  readonly isRemote: boolean;
  readonly readOnly: boolean;

  listDirectory(dir: string): Promise<DirectoryEntry[]>;
  readTree(dir?: string, maxDepth?: number): Promise<FileNode[]>;
  readText(absPath: string): Promise<string>;
  writeText(absPath: string, content: string): Promise<void>;
  resolveInsideRoot(path: string): Promise<string>;

  /** Local path string for git/bash when applicable. */
  execRoot(): string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
