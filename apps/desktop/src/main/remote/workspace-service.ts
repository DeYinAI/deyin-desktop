import { homedir as nodeHomedir } from "node:os";
import { join } from "node:path";
import type { SshHostsStore } from "@deyin/host-core";
import {
  LocalHostBackend,
  RemoteHostBackend,
  RemoteGitService,
  listRemoteDirectory,
  type HostBackend,
  type WorkspaceLocation,
  type WorkspaceState,
} from "@deyin/host-core";
import { execCommand } from "../automations/ssh-client.js";
import { SshConnectionPool } from "./connection-pool.js";

function emptyState(): WorkspaceState {
  return {
    location: null,
    connected: false,
    connectionState: "disconnected",
    label: "",
  };
}

function labelFor(loc: WorkspaceLocation, hostLabel?: string): string {
  if (loc.kind === "remote") {
    const host = hostLabel ?? loc.hostId;
    return `${host}:${loc.root}`;
  }
  const home = nodeHomedir().replace(/\\/g, "/");
  const root = loc.root.replace(/\\/g, "/");
  if (root === home || root.startsWith(`${home}/`)) return `~${root.slice(home.length)}`;
  return root;
}

/** Manages the active HostBackend (local or remote SSH). */
export class WorkspaceService {
  private backend: HostBackend | null = null;
  private remoteGit: RemoteGitService | null = null;
  private state: WorkspaceState = emptyState();
  private poolRelease: (() => void) | null = null;
  private readonly pool = new SshConnectionPool();

  constructor(private readonly sshHosts: SshHostsStore) {}

  getRemoteGit(): RemoteGitService | null {
    return this.remoteGit;
  }

  isRemote(): boolean {
    return this.backend?.isRemote ?? false;
  }

  getBackend(): HostBackend | null {
    return this.backend;
  }

  getState(): WorkspaceState {
    return this.state;
  }

  displayRoot(): string | null {
    if (!this.state.location) return null;
    if (this.state.location.kind === "local") return this.state.location.root;
    return this.state.label;
  }

  execRoot(): string | null {
    return this.backend?.execRoot() ?? null;
  }

  private setState(patch: Partial<WorkspaceState>): WorkspaceState {
    this.state = { ...this.state, ...patch };
    return this.state;
  }

  async setLocal(root: string): Promise<WorkspaceState> {
    await this.teardownRemote();
    this.remoteGit = null;
    const loc: WorkspaceLocation = { kind: "local", root };
    this.backend = new LocalHostBackend(root);
    await this.backend.connect();
    return this.setState({
      location: loc,
      connected: true,
      connectionState: "connected",
      label: labelFor(loc),
      error: undefined,
    });
  }

  async connectRemote(hostId: string, remotePath: string, hostLabel?: string): Promise<WorkspaceState> {
    await this.teardownRemote();
    this.setState({ connectionState: "connecting", error: undefined });
    try {
      const { client, sftp, release } = await this.pool.acquire({ hostId, hosts: this.sshHosts });
      this.poolRelease = release;
      const exec = (command: string) => execCommand(client, command);
      const backend = new RemoteHostBackend(
        hostId,
        remotePath,
        sftp,
        exec,
        false,
        hostLabel ? `${hostLabel}:${remotePath}` : undefined,
      );
      await backend.connect();
      this.backend = backend;
      this.remoteGit = new RemoteGitService(exec, remotePath);
      const loc = backend.location;
      return this.setState({
        location: loc,
        connected: true,
        connectionState: "connected",
        label: labelFor(loc, hostLabel),
        error: undefined,
      });
    } catch (err) {
      if (this.poolRelease) {
        this.poolRelease();
        this.poolRelease = null;
      }
      if (this.state.location?.kind === "remote") {
        this.pool.disconnect(this.state.location.hostId);
      }
      this.backend = null;
      this.remoteGit = null;
      return this.setState({
        location: null,
        connected: false,
        connectionState: "error",
        label: "",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async disconnect(): Promise<WorkspaceState> {
    await this.teardownRemote();
    this.backend = null;
    this.remoteGit = null;
    return this.setState(emptyState());
  }

  private async teardownRemote(): Promise<void> {
    if (this.poolRelease) {
      this.poolRelease();
      this.poolRelease = null;
    }
    if (this.state.location?.kind === "remote") {
      this.pool.disconnect(this.state.location.hostId);
    }
    await this.backend?.disconnect();
  }

  async listLocalDirectory(dir: string) {
    const backend = new LocalHostBackend(dir);
    return backend.listDirectory(dir);
  }

  async listRemoteDirectory(hostId: string, dir: string) {
    const { sftp, release } = await this.pool.acquire({ hostId, hosts: this.sshHosts });
    try {
      return await listRemoteDirectory(sftp, dir);
    } finally {
      release();
    }
  }

  dispose(): void {
    void this.teardownRemote();
    this.pool.disconnectAll();
  }
}

export function defaultCloneRoot(): string {
  return join(nodeHomedir(), ".deyin", "clones");
}
