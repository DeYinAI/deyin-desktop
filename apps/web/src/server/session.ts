import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { GitWatcher, generateImages, generateVideo, git as gitService, imageDataUrl, imageParamsToExtra, isValidArtifactUserSub, modelImageCapability, runGit, videoDataUrl, videoParamsToExtra, revertCheckpoint, revertCheckpoints, assertInsideRoot } from "@deyin/host-core";
import type { CheckpointFileOps } from "@deyin/host-core";
import type { ClientMessage, ServerMessage } from "@deyin/contract/web";
import { SessionHost } from "./host.js";
import { WebAgentHost, type WebAgentStartOptions } from "./agent-host.js";
import { RepoManager } from "./repo.js";
import { introspect } from "./introspect.js";
import { GatedArtifactStore } from "./gated-artifacts.js";
import { getSharedArtifactObjectStore } from "./artifacts-backend.js";

/** git.call ops that mutate state — each completion pushes git.changed to the client. */
const GIT_MUTATION_OPS = new Set([
  "checkout",
  "stage",
  "unstage",
  "discard",
  "commit",
  "fetch",
  "pull",
  "push",
  "createBranch",
  "deleteBranch",
  "stashPush",
  "stashPop",
  "stashDrop",
]);

/**
 * Drives one authenticated WebSocket connection: validates the token, provisions a
 * sandbox root, and dispatches host RPCs. In production the sandbox root is a container
 * volume; here it is a temp workspace.
 */
export class Session {
  private host?: SessionHost;
  private agentHost?: WebAgentHost;
  private repo?: RepoManager;
  private artifacts?: GatedArtifactStore;
  private gitWatcher?: GitWatcher;
  private authed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly issuer: string,
  ) {}

  send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async handle(raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }

    if (msg.type === "auth") {
      const result = await introspect(this.issuer, msg.token);
      if (!result.active) {
        this.send({ type: "auth.err", message: "Invalid or expired token." });
        this.ws.close();
        return;
      }
      const r2 = getSharedArtifactObjectStore();
      const userSub = result.sub;
      if (r2 && !isValidArtifactUserSub(userSub)) {
        this.send({ type: "auth.err", message: "Signed-in user id is required for artifact storage." });
        this.ws.close();
        return;
      }
      const root = await mkdtemp(join(tmpdir(), "deyin-session-"));
      this.host = new SessionHost(root, (m) => this.send(m));
      this.artifacts = new GatedArtifactStore(userSub ?? "local-dev", root, r2);
      this.repo = new RepoManager(root, {}, (stage, line) => this.send({ type: "repo.progress", stage, line }));
      this.agentHost = new WebAgentHost(
        root,
        this.host.terminalManager,
        (envelope) => this.send({ type: "agent.event", envelope }),
        (m) => this.send(m),
        () => this.repo?.branchInfo() ?? null,
        this.artifacts,
      );
      // Catch agent/terminal git activity and let the client refetch state.
      this.gitWatcher = new GitWatcher(() => this.send({ type: "git.changed" }));
      this.gitWatcher.watch(root);
      this.authed = true;
      this.send({ type: "auth.ok", user: { sub: result.sub ?? "unknown", plan: result.plan }, workspaceRoot: root });
      return;
    }

    if (!this.authed || !this.host || !this.agentHost) {
      this.send({ type: "auth.err", message: "Not authenticated." });
      return;
    }

    try {
      switch (msg.type) {
        case "files.tree":
          this.send({ type: "reply", id: msg.id, ok: true, result: { nodes: await this.host.tree(msg.dir) } });
          break;
        case "files.read":
          this.send({ type: "reply", id: msg.id, ok: true, result: { content: await this.host.read(msg.path) } });
          break;
        case "files.write":
          await this.host.write(msg.path, msg.content);
          this.send({ type: "reply", id: msg.id, ok: true, result: { ok: true } });
          break;
        case "env.detect":
          this.send({ type: "reply", id: msg.id, ok: true, result: { env: await this.host.env() } });
          break;
        case "term.create":
          this.send({ type: "reply", id: msg.id, ok: true, result: { termId: await this.host.createTerminal(msg.opts) } });
          break;
        case "term.attach":
          this.send({ type: "reply", id: msg.id, ok: true, result: this.host.attachTerminal(msg.termId) });
          break;
        case "term.write":
          this.host.writeTerminal(msg.termId, msg.data);
          break;
        case "term.resize":
          this.host.resizeTerminal(msg.termId, msg.cols, msg.rows);
          break;
        case "term.kill":
          this.host.killTerminal(msg.termId);
          break;
        case "agent.start": {
          const options = msg as WebAgentStartOptions & { type: "agent.start"; id: number };
          this.agentHost.start({
            threadId: options.threadId,
            prompt: options.prompt,
            model: options.model,
            thinking: options.thinking,
            effort: options.effort,
            approvalMode: options.approvalMode,
            mode: options.mode,
            history: options.history,
            initialTodos: options.initialTodos,
            goalText: options.goalText,
            images: options.images,
            imageModels: options.imageModels,
            imageChatModels: options.imageChatModels,
            runId: options.runId,
            contextLength: options.contextLength,
            disabledCaps: options.disabledCaps,
            provider: options.provider,
            roleModels: options.roleModels,
            roleProviders: options.roleProviders,
          });
          this.send({ type: "reply", id: msg.id, ok: true, result: undefined });
          break;
        }
        case "agent.stop":
          this.agentHost.stop(msg.threadId);
          break;
        case "agent.resetSession":
          this.agentHost.resetSession(msg.threadId);
          this.send({ type: "reply", id: msg.id, ok: true, result: undefined });
          break;
        case "agent.disposeShell":
          this.agentHost.disposeShell(msg.threadId);
          break;
        case "agent.approve":
          this.agentHost.approve(msg.requestId, msg.decision);
          break;
        case "agent.answer":
          this.agentHost.answerQuestion(msg.requestId, msg.answers);
          break;
        case "checkpoints.revertRun": {
          const result = await this.revertCheckpoint(msg.threadId, msg.checkpointId);
          this.send({ type: "reply", id: msg.id, ok: true, result });
          break;
        }
        case "checkpoints.revertFile": {
          const result = await this.revertCheckpoint(msg.threadId, msg.checkpointId, msg.path);
          this.send({ type: "reply", id: msg.id, ok: true, result });
          break;
        }
        case "checkpoints.revertAfterEvent": {
          const store = this.agentHost.getCheckpointStore();
          const result = await revertCheckpoints(
            store,
            store.getStorage(),
            this.checkpointFileOps(),
            msg.threadId,
            msg.checkpointIds,
            { isAgentRunning: (threadId) => this.agentHost!.isRunning(threadId) },
          );
          if (result.ok && msg.checkpointIds.length > 0) {
            const drop = new Set(msg.checkpointIds);
            const keep = new Set(
              store.list(msg.threadId).map((e) => e.checkpointId).filter((id) => !drop.has(id)),
            );
            await store.pruneCheckpoints(msg.threadId, keep);
          }
          this.send({ type: "reply", id: msg.id, ok: true, result });
          break;
        }
        case "git.call": {
          const result = await this.dispatchGit(msg.op, msg.args);
          this.send({ type: "reply", id: msg.id, ok: true, result });
          if (GIT_MUTATION_OPS.has(msg.op)) this.send({ type: "git.changed" });
          break;
        }
        case "repo.connect": {
          if (!this.repo) throw new Error("Session not ready.");
          const state = await this.repo.connect({ url: msg.url, token: msg.token, branch: msg.branch });
          this.gitWatcher?.watch(this.host.root);
          this.send({ type: "reply", id: msg.id, ok: true, result: state });
          this.send({ type: "git.changed" });
          break;
        }
        case "images.save": {
          if (!this.artifacts) throw new Error("Session not ready.");
          const saved = await this.artifacts.saveImage(msg.threadId, { base64: msg.base64, mediaType: msg.mediaType });
          this.send({ type: "reply", id: msg.id, ok: true, result: { file: saved.file } });
          break;
        }
        case "images.read": {
          if (!this.artifacts) throw new Error("Session not ready.");
          const image = await this.artifacts.readImage(msg.threadId, msg.file);
          this.send({ type: "reply", id: msg.id, ok: true, result: { dataUrl: imageDataUrl(image) } });
          break;
        }
        case "visualize.read": {
          if (!this.artifacts) throw new Error("Session not ready.");
          this.send({ type: "reply", id: msg.id, ok: true, result: { html: await this.artifacts.readPage(msg.threadId, msg.file) } });
          break;
        }
        case "page.read": {
          if (!this.artifacts) throw new Error("Session not ready.");
          this.send({ type: "reply", id: msg.id, ok: true, result: { html: await this.artifacts.readPage(msg.threadId, msg.file) } });
          break;
        }
        case "images.generate": {
          if (!this.artifacts) throw new Error("Session not ready.");
          const capability = modelImageCapability(msg.model);
          const route = capability === "none" ? "endpoint" : capability;
          const extra = imageParamsToExtra({
            negativePrompt: msg.negativePrompt,
            numSteps: msg.numSteps,
            guidance: msg.guidance,
            seed: msg.seed,
            strength: msg.strength,
          });
          const generated = await generateImages({
            apiBaseUrl: msg.provider.baseUrl,
            token: msg.provider.token,
            model: msg.model,
            route,
            prompt: msg.prompt,
            size: msg.size ?? "1024x1024",
            n: msg.n ?? 1,
            ...(Object.keys(extra).length > 0 ? { extra } : {}),
          });
          const images = generated.map((image) => {
            const saved = this.artifacts!.images.save(msg.threadId, { base64: image.base64, mediaType: image.mediaType });
            void this.artifacts!.mirrorImageSave(msg.threadId, saved.file).catch(() => undefined);
            return {
              file: saved.file,
              mediaType: saved.mediaType,
              ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
            };
          });
          this.send({ type: "reply", id: msg.id, ok: true, result: { images, model: msg.model } });
          break;
        }
        case "videos.save": {
          if (!this.artifacts) throw new Error("Session not ready.");
          const saved = await this.artifacts.saveVideo(msg.threadId, { base64: msg.base64, mediaType: msg.mediaType });
          this.send({ type: "reply", id: msg.id, ok: true, result: { file: saved.file } });
          break;
        }
        case "videos.read": {
          if (!this.artifacts) throw new Error("Session not ready.");
          const video = await this.artifacts.readVideo(msg.threadId, msg.file);
          this.send({ type: "reply", id: msg.id, ok: true, result: { dataUrl: videoDataUrl(video) } });
          break;
        }
        case "videos.generate": {
          if (!this.artifacts) throw new Error("Session not ready.");
          const extra = videoParamsToExtra(
            {
              aspectRatio: msg.aspectRatio,
              seconds: msg.seconds,
              size: msg.size,
              seed: msg.seed,
              mode: msg.mode,
            },
            { inputImageCount: msg.inputImages?.length ?? 0, modelId: msg.model },
          );
          const generated = await generateVideo({
            apiBaseUrl: msg.provider.baseUrl,
            token: msg.provider.token,
            model: msg.model,
            prompt: msg.prompt,
            inputImages: msg.inputImages,
            extra,
          });
          const saved = this.artifacts.videos.save(msg.threadId, {
            base64: generated.base64,
            mediaType: generated.mediaType,
          });
          void this.artifacts.mirrorVideoSave(msg.threadId, saved.file).catch(() => undefined);
          this.send({
            type: "reply",
            id: msg.id,
            ok: true,
            result: { video: { file: saved.file, mediaType: saved.mediaType }, model: msg.model },
          });
          break;
        }
        case "repo.state":
          this.send({ type: "reply", id: msg.id, ok: true, result: this.repo?.state() ?? { connected: false, url: null, branch: null, defaultBranch: null } });
          break;
        case "repo.ship": {
          if (!this.repo) throw new Error("Session not ready.");
          const result = await this.repo.ship(msg.message);
          this.send({ type: "reply", id: msg.id, ok: true, result });
          this.send({ type: "git.changed" });
          break;
        }
      }
    } catch (err) {
      if ("id" in msg && typeof msg.id === "number") {
        this.send({ type: "reply", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * Map a generic git RPC onto the shared host-core git service. Network ops
   * (fetch/pull/push) route through the session token so private repos work.
   */
  private async dispatchGit(op: string, args: unknown[]): Promise<unknown> {
    const root = this.hostRoot();
    const lite = (r: { ok: boolean; stdout: string; stderr: string }, okMsg: string) => ({
      ok: r.ok,
      message: (r.ok ? r.stdout : r.stderr).trim() || (r.ok ? okMsg : "git command failed"),
    });
    switch (op) {
      case "info":
        return root ? gitService.repoInfo(root) : { isRepo: false, root: null, branch: null, detached: false, ahead: 0, behind: 0, remotes: [] };
      case "status":
        return root ? gitService.status(root) : { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicts: [] };
      case "branches":
        return root ? gitService.branches(root) : [];
      case "checkout":
        return lite(await gitService.checkout(root, String(args[0])), `Switched to ${String(args[0])}`);
      case "stage":
        return lite(await gitService.stage(root, (args[0] as string[]) ?? []), "Staged");
      case "unstage":
        return lite(await gitService.unstage(root, (args[0] as string[]) ?? []), "Unstaged");
      case "discard":
        return lite(await gitService.discard(root, (args[0] as string[]) ?? []), "Discarded");
      case "commit":
        return lite(await gitService.commit(root, String(args[0]), (args[1] as { amend?: boolean }) ?? {}), "Committed");
      case "fetch":
        return lite(await runGit(root, [...this.authArgs(), "fetch", "--all"]), "Fetched");
      case "pull": {
        const opts = (args[0] as { rebase?: boolean }) ?? {};
        return lite(await runGit(root, [...this.authArgs(), opts.rebase ? "pull" : "pull", ...(opts.rebase ? ["--rebase"] : [])]), "Pulled");
      }
      case "push": {
        const opts = (args[0] as { setUpstream?: boolean; remote?: string }) ?? {};
        if (opts.setUpstream) {
          const info = await gitService.repoInfo(root);
          if (info.branch) {
            return lite(await runGit(root, [...this.authArgs(), "push", "-u", opts.remote ?? "origin", info.branch]), "Pushed");
          }
        }
        return lite(await runGit(root, [...this.authArgs(), "push"]), "Pushed");
      }
      case "createBranch":
        return lite(await gitService.createBranch(root, String(args[0]), args[1] as string | undefined), `Created ${String(args[0])}`);
      case "deleteBranch":
        return lite(await gitService.deleteBranch(root, String(args[0]), Boolean(args[1])), `Deleted ${String(args[0])}`);
      case "log":
        return gitService.log(root, (args[0] as { limit?: number; skip?: number; path?: string; ref?: string }) ?? {});
      case "show":
        return gitService.show(root, String(args[0]));
      case "diffFile":
        return gitService.diffFile(root, String(args[0]), (args[1] as "worktree" | "staged" | "head") ?? "worktree");
      case "diffCommit":
        return gitService.diffCommit(root, String(args[0]), String(args[1]));
      case "blame":
        return gitService.blame(root, String(args[0]));
      case "remotes":
        return gitService.remotes(root);
      case "stashList":
        return gitService.stashList(root);
      case "stashPush":
        return lite(await gitService.stashPush(root, args[0] as string | undefined, Boolean(args[1])), "Stashed");
      case "stashPop":
        return lite(await gitService.stashPop(root, (args[0] as number) ?? 0), "Popped stash");
      case "stashDrop":
        return lite(await gitService.stashDrop(root, (args[0] as number) ?? 0), "Dropped stash");
      default:
        throw new Error(`Unknown git op: ${op}`);
    }
  }

  private hostRoot(): string {
    if (!this.host) throw new Error("Session not ready.");
    return this.host.root;
  }

  private authArgs(): string[] {
    return this.repo?.authArgs() ?? [];
  }

  private checkpointFileOps(): CheckpointFileOps {
    const host = this.host!;
    const root = host.root;
    return {
      readText: (path) => host.read(path),
      writeText: (path, content) => host.write(path, content),
      delete: async (path) => {
        const safe = assertInsideRoot(root, path);
        const { unlink } = await import("node:fs/promises");
        await unlink(safe).catch(() => undefined);
      },
      exists: async (path) => {
        try {
          const safe = assertInsideRoot(root, path);
          const { access } = await import("node:fs/promises");
          await access(safe);
          return true;
        } catch {
          return false;
        }
      },
      resolveInsideRoot: async (path) => assertInsideRoot(root, path),
    };
  }

  private async revertCheckpoint(threadId: string, checkpointId: string, path?: string) {
    const store = this.agentHost!.getCheckpointStore();
    return revertCheckpoint(
      store,
      store.getStorage(),
      this.checkpointFileOps(),
      threadId,
      checkpointId,
      { isAgentRunning: (id) => this.agentHost!.isRunning(id) },
      path ? { paths: [path] } : undefined,
    );
  }

  dispose(): void {
    this.agentHost?.dispose();
    this.gitWatcher?.stop();
    this.host?.dispose();
  }
}
