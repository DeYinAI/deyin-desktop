import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { GitWatcher, ImageStore, generateImages, git as gitService, imageDataUrl, runGit } from "@deyin/host-core";
import type { ClientMessage, ServerMessage } from "@deyin/contract/web";
import { SessionHost } from "./host.js";
import { WebAgentHost, type WebAgentStartOptions } from "./agent-host.js";
import { RepoManager } from "./repo.js";
import { introspect } from "./introspect.js";

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
  private images?: ImageStore;
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
      const root = await mkdtemp(join(tmpdir(), "deyin-session-"));
      this.host = new SessionHost(root, (m) => this.send(m));
      // Generated images live inside the sandbox, like every other session artifact.
      this.images = new ImageStore(join(root, ".deyin", "images"));
      this.repo = new RepoManager(root, {}, (stage, line) => this.send({ type: "repo.progress", stage, line }));
      this.agentHost = new WebAgentHost(
        root,
        this.host.terminalManager,
        (envelope) => this.send({ type: "agent.event", envelope }),
        (m) => this.send(m),
        () => this.repo?.branchInfo() ?? null,
        this.images,
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
        case "agent.disposeShell":
          this.agentHost.disposeShell(msg.threadId);
          break;
        case "agent.approve":
          this.agentHost.approve(msg.requestId, msg.decision);
          break;
        case "agent.answer":
          this.agentHost.answerQuestion(msg.requestId, msg.answers);
          break;
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
          if (!this.images) throw new Error("Session not ready.");
          const saved = this.images.save(msg.threadId, { base64: msg.base64, mediaType: msg.mediaType });
          this.send({ type: "reply", id: msg.id, ok: true, result: { file: saved.file } });
          break;
        }
        case "images.read": {
          if (!this.images) throw new Error("Session not ready.");
          this.send({ type: "reply", id: msg.id, ok: true, result: { dataUrl: imageDataUrl(this.images.read(msg.threadId, msg.file)) } });
          break;
        }
        case "images.generate": {
          if (!this.images) throw new Error("Session not ready.");
          const generated = await generateImages({
            apiBaseUrl: msg.provider.baseUrl,
            token: msg.provider.token,
            model: msg.model,
            prompt: msg.prompt,
            size: msg.size ?? "1024x1024",
            n: msg.n ?? 1,
            ...(msg.negativePrompt ? { extra: { negative_prompt: msg.negativePrompt } } : {}),
          });
          const images = generated.map((image) => {
            const saved = this.images!.save(msg.threadId, { base64: image.base64, mediaType: image.mediaType });
            return {
              file: saved.file,
              mediaType: saved.mediaType,
              ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
            };
          });
          this.send({ type: "reply", id: msg.id, ok: true, result: { images, model: msg.model } });
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

  dispose(): void {
    this.agentHost?.dispose();
    this.gitWatcher?.stop();
    this.host?.dispose();
  }
}
