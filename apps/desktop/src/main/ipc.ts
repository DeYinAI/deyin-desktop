import { randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";
import { BrowserWindow, app, dialog, ipcMain, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
  AccountCache,
  AgentsStore,
  IndexManager,
  MemoryStore,
  ModelsCache,
  ProjectsStore,
  SettingsStore,
  TelemetryReporter,
  TerminalManager,
  UsageStore,
  detectEnv,
  git,
  GitWatcher,
  imageDataUrl,
  type GitResult,
  webSearch,
} from "@deyin/host-core";
import { fetchPublicPlans, fetchReleaseStatus, projectLocation } from "@deyin/host-core/shared";
import {
  abortCrossCurrencyUpgrade,
  completeCrossCurrencyUpgrade,
  fetchBillingOverview,
  fetchBillingPublishableKey,
  selectPlan,
} from "@deyin/host-core/shared";
import { resolveContextRefs, searchContextPaths } from "@deyin/host-core";
import type { PermissionDecision } from "@deyin/agent-core";
import { CH } from "@deyin/contract";
import type {
  AgentImageInput,
  AgentStartOptions,
  Automation,
  Bootstrap,
  CapabilityKind,
  DeyinSettings,
  GitBranch,
  GitRepoInfo,
  GitResultLite,
  GitStatus,
  ImageGenerateRequest,
  McpServerInput,
  ProjectsState,
  ProviderPatch,
  SshHostCredentials,
  SshHostInput,
  TerminalCreateOptions,
  UsageEvent,
} from "@deyin/contract";
import type { DeyinConfig } from "@deyin/contract";
import { DesktopAgentHost } from "./agent.js";
import { AutomationsStore } from "@deyin/host-core";
import { AutomationService } from "./automations/service.js";
import type { AgentRunContextDeps } from "./automations/agent-run-context.js";
import { testWslDistro } from "./automations/wsl-executor.js";
import type { AuthManager } from "./auth.js";
import { BrowserControlService, workspacePartition } from "./browser.js";
import { ComputerUseService } from "./computer-use.js";
import { CapabilityService } from "./capabilities.js";
import { DiagnosticsService } from "./diagnostics.js";
import { IdentityService } from "./identity.js";
import { logLine } from "./logger.js";
import { PluginService } from "./plugins.js";
import { createDesktopStorage } from "./storage.js";
import { createUpdateController } from "./updater.js";
import { McpCatalogService } from "./mcp-catalog.js";
import { createMcpAuthBridge } from "./mcp-auth-bridge.js";
import { McpModuleService } from "./mcp-modules.js";
import { McpOAuthService } from "./mcp-oauth.js";
import { SecurityService } from "./security.js";
import { scanDiffViaMcp } from "./security-scan.js";
import { VisualizeService } from "./visualize.js";
import { PageService } from "./page.js";
import { ImageService } from "./images.js";
import { runImageGeneration, type ImageRouting } from "./image-gen.js";
import { LocalVisionService } from "./local-vision-service.js";
import { PendingReviewQueue } from "./pending-review.js";
import { WorkspaceTrustStore } from "./workspace-trust.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { RepoManager } from "@deyin/host-core";
import { defaultCloneRoot, WorkspaceService } from "./remote/workspace-service.js";
import { GitHubService } from "./github.js";
import type { RepoConnectRequest, RepoProgressEvent, WorkspaceState } from "@deyin/contract";

interface RegisterOptions {
  config: DeyinConfig;
  auth: AuthManager;
  getWorkspaceRoot: () => string | null;
  setWorkspaceRoot: (root: string | null) => void;
}

export interface IpcServices {
  terminals: TerminalManager;
  shouldKeepRunningInBackground: () => boolean;
  /** Call when the auth session changes (login/logout) to drop server caches. */
  notifyAuthChanged: () => void;
  /** Async teardown for app quit (agent runs, telemetry, automations, …). */
  shutdown: () => Promise<void>;
}

function windowOf(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

/** Register every IPC handler exactly once, after app is ready. */
export function registerIpc(opts: RegisterOptions): IpcServices {
  const { config, auth } = opts;

  const storage = createDesktopStorage();
  const settings = new SettingsStore(storage);
  const agents = new AgentsStore(storage);
  const usage = new UsageStore(storage);
  const projects = new ProjectsStore(storage);

  /* Server-side caches (P1): plan/account snapshot + 1-week model list. */
  const accountCache = new AccountCache(storage, config, () => auth.getAccessToken());
  const modelsCache = new ModelsCache(storage, config, () => auth.getAccessToken());

  /* Identity & diagnostics: live data for the Identity page + support uploads. */
  const identity = new IdentityService({
    storage,
    config,
    auth,
    accountCache,
    agents,
    getWorkspaceRoot: opts.getWorkspaceRoot,
  });
  const diagnostics = new DiagnosticsService({
    storage,
    config,
    auth,
    settings,
    usage,
    getWorkspaceRoot: opts.getWorkspaceRoot,
  });
  // Hold exit open just long enough for the final telemetry batch to upload.
  app.on("will-quit", (event) => {
    if (telemetryFlushed) return;
    event.preventDefault();
    telemetryFlushed = true;
    void telemetry.flush().finally(() => app.exit(0));
  });

  // Register this workstation on startup when a session exists; best effort.
  void auth.getUser().then((user) => {
    if (user) void identity.sync();
  });

  /* Telemetry (opt-in; anonymous install id). */
  const telemetryMeta = storage.readJson<{ installId: string }>("telemetry.json", { installId: "" });
  if (!telemetryMeta.installId) {
    telemetryMeta.installId = randomUUID();
    storage.writeJson("telemetry.json", telemetryMeta);
  }
  const telemetry = new TelemetryReporter({
    endpoint: `${config.oauthIssuer.replace(/\/$/, "")}/api/telemetry`,
    isEnabled: () => settings.get().telemetry,
    installId: telemetryMeta.installId,
    appVersion: app.getVersion(),
    platform: process.platform,
  });
  telemetry.start();
  telemetry.record("app-start");

  let telemetryFlushed = false;

  /* Updates. */
  const updates = createUpdateController({
    isAutoUpdateEnabled: () => settings.get().autoUpdate,
  });
  ipcMain.handle(CH.updatesGetState, () => updates.getState());
  ipcMain.handle(CH.updatesCheck, (_e, opts?: { userInitiated?: boolean }) => updates.check(opts));
  ipcMain.handle(CH.updatesDownload, () => updates.download());
  ipcMain.on(CH.updatesInstall, () => updates.install());
  // Always poll on launch so users with auto-update off still see the banner;
  // download stays gated by settings.autoUpdate / explicit Download click.
  // Deferred past first paint so the network round-trip never blocks startup.
  setTimeout(() => void updates.check(), 10_000);
  // Re-check every 24h for long-running sessions.
  setInterval(() => void updates.check(), 24 * 60 * 60 * 1000);

  /* Capabilities, plugins, browser control, indexing, agent runtime. */
  const pluginsDir = join(app.getPath("userData"), "plugins");
  const builtinSkillsDir = join(app.getPath("userData"), "builtin-skills");
  const trust = new WorkspaceTrustStore(
    () => storage.readJson<string[]>("workspace-trust.json", []),
    (roots) => storage.writeJson("workspace-trust.json", roots),
  );
  const capabilities = new CapabilityService(
    agents,
    opts.getWorkspaceRoot,
    pluginsDir,
    builtinSkillsDir,
    () => settings.get(),
    () => trust.isTrusted(opts.getWorkspaceRoot() ?? ""),
  );
  // Bundled first-party plugins materialize into userData/plugins on startup
  // (source dir: repo checkout in dev, resources/ in packaged builds).
  const bundledSrcDir = app.isPackaged
    ? join(process.resourcesPath, "bundled-plugins")
    : join(app.getAppPath(), "bundled-plugins");
  const plugins = new PluginService(pluginsDir, storage, agents, capabilities, existsSync(bundledSrcDir) ? bundledSrcDir : undefined);
  const browser = new BrowserControlService(opts.getWorkspaceRoot, () => settings.get().browserControlEnabled);

  const computerUse = new ComputerUseService(
    () => settings.get().computerUseEnabled,
    () => process.platform === "win32",
    () => settings.get().computerUseScreenshotRetentionDays,
  );
  const pendingAppApprovals = new Map<
    string,
    { resolve: (decision: "always" | "once" | "deny") => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  computerUse.setAppApprovalResolver(async (req) => {
    return new Promise<"always" | "once" | "deny">((resolve, reject) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        pendingAppApprovals.delete(requestId);
        reject(new Error(`App approval timed out for "${req.appId}".`));
      }, 5 * 60 * 1000);
      pendingAppApprovals.set(requestId, { resolve, reject, timer });
      broadcast(CH.computerUseAppApprovalRequest, { requestId, appId: req.appId, action: req.action });
    });
  });

  const index = new IndexManager({
    indexRoot: join(app.getPath("userData"), "index"),
    modelCacheDir: join(app.getPath("userData"), "models"),
    isEnabled: () => settings.get().indexingEnabled,
    onStatus: (status) => broadcast(CH.indexStatusEvent, status),
  });

  // Terminal output follows the window that created/attached the terminal —
  // a fallback lookup would silently drop data whenever no window is focused.
  const termSenders = new Map<number, Electron.WebContents>();
  const senderFor = (id: string) => {
    const wc = termSenders.get(Number(id));
    if (wc && !wc.isDestroyed()) return wc;
    // Fallback for agent shells announced without a creator (e.g. restored runs).
    const fallback = BrowserWindow.getFocusedWindow()?.webContents ?? BrowserWindow.getAllWindows()[0]?.webContents ?? null;
    return fallback;
  };
  const terminals = new TerminalManager({
    onData: (id, data) => senderFor(id)?.send(CH.termData, { id, data }),
    onExit: (id, exitCode) => {
      termSenders.delete(Number(id));
      senderFor(id)?.send(CH.termExit, { id, exitCode });
    },
  });

  const memory = new MemoryStore(app.getPath("userData"));

  /* Change review queue: shared between the agent runtime (write/edit/delete
     gating) and the renderer's review list/approve/reject IPC. */
  const review = new PendingReviewQueue();
  const broadcastReviewResolved = (threadId: string, changeId: string, status: "approved" | "rejected") => {
    broadcast("deyin:agent:event", {
      threadId,
      event: { type: "pending-change-resolved", changeId, threadId, status },
    } satisfies { threadId: string; event: unknown });
  };

  /* Security findings + host tool services. */
  const security = new SecurityService();
  const visualize = new VisualizeService();
  const pages = new PageService();
  const images = new ImageService();
  const localVision = new LocalVisionService(pluginsDir, agents);

  /** Provider routing for image generation, mirroring the chat/agent routing. */
  const imageRouting = (providerId?: string): ImageRouting => {
    const provider = providerId ? agents.listProviders(true).find((p) => p.id === providerId) : undefined;
    if (!provider || provider.kind === "primary") {
      return { apiBaseUrl: config.apiBaseUrl, getToken: () => auth.getAccessToken() };
    }
    return {
      apiBaseUrl: provider.baseUrl ?? config.apiBaseUrl,
      getToken: () => Promise.resolve(agents.getKey(provider.id) ?? (provider.local ? "" : null)),
    };
  };

  /* MCP modules / catalog / native OAuth. */
  const mcpModules = new McpModuleService(homedir(), () => capabilities.invalidate());
  void mcpModules.migrateFlatMcp();
  const mcpCatalog = new McpCatalogService(mcpModules);
  const mcpOAuth = new McpOAuthService();
  const moduleMcpUrl = (moduleId: string): string => {
    try {
      const raw = JSON.parse(readFileSync(pathJoin(mcpModules.moduleDir(moduleId), "mcp.json"), "utf8")) as {
        mcpServers?: Record<string, { url?: string }>;
      };
      return raw.mcpServers?.[moduleId]?.url ?? "";
    } catch {
      return "";
    }
  };

  const getContextLength = (providerId: string, modelId: string): number | undefined => {
    const provider = agents.listProviders(true).find((p) => p.id === providerId);
    const fromProvider = provider?.models.find((m) => m.id === modelId)?.contextLength;
    if (fromProvider) return fromProvider;
    // Primary Openference catalog lives in ModelsCache (provider.models is often empty).
    return modelsCache.listCached().find((m) => m.id === modelId)?.contextLength;
  };

  /** Shared by the interactive host and the unattended automation executors. */
  const agentDeps: AgentRunContextDeps = {
    config,
    auth,
    agents,
    settings,
    capabilities,
    browser,
    memory,
    trust,
    getWorkspaceRoot: opts.getWorkspaceRoot,
    searchIndex: (query, topK) => index.search(query, topK),
    getContextLength,
    mcpAuth: createMcpAuthBridge(mcpModules, mcpOAuth),
  };

  const automations = new AutomationService({
    storage,
    deps: agentDeps,
    auth,
    isCatchUpEnabled: () => settings.get().automationsCatchUp,
  });

  // First-run seed: give the Automations view something real to show. Only
  // fires when automations.json does not exist yet — never resurrects an
  // automation the user deleted (the file exists from then on). lastScheduledAt
  // is set to now so scheduler catch-up does not fire a stale slot for it.
  try {
    if (!existsSync(join(storage.dir, "automations.json"))) {
      const store = new AutomationsStore(storage);
      const now = Date.now();
      const prompt = [
        "Research the latest news on the web about newly released or updated frontier LLMs",
        "(OpenAI, Anthropic, Google, Meta, DeepSeek, xAI, Alibaba Qwen, Mistral).",
        "Use web search. Focus on the last 7 days: model names, sizes, benchmarks, pricing,",
        "availability. Write a concise markdown digest to daily-news.md in that workspace",
        "(create it if missing, prepend today's date as a section). Keep the file under 200",
        "lines, newest entries first.",
      ].join(" ");
      store.create({
        name: "Latest Model News Research",
        description:
          "Daily 8:00 AM digest of the newest frontier LLM releases (OpenAI, Anthropic, Google, Meta, DeepSeek, xAI, Qwen)",
        enabled: true,
        payload: { kind: "prompt", prompt },
        trigger: { kind: "cron", expression: "0 8 * * *" },
        target: { kind: "local", workspacePath: "C:\\Users\\Anh\\news-digest" },
        model: settings.get().defaultModel?.split("::")[1] ?? "",
        providerId: "openference",
        lastScheduledAt: now,
      });
    }
  } catch (err) {
    console.warn("[deyin] automation seed skipped:", err);
  }

  const agentHost = new DesktopAgentHost({
    config,
    auth,
    agents,
    settings,
    capabilities,
    browser,
    computerUse,
    visualize,
    pages,
    images,
    automations,
    terminals,
    memory,
    review,
    mcpAuth: createMcpAuthBridge(mcpModules, mcpOAuth),
    security,
    trust,
    getWorkspaceRoot: opts.getWorkspaceRoot,
    searchIndex: (query, topK) => index.search(query, topK),
    getContextLength,
    getImageModels: (providerId) => {
      const provider = agents.listProviders(true).find((p) => p.id === providerId);
      const list = provider && provider.kind !== "primary" ? provider.models : modelsCache.listCached();
      // Dedicated text-to-image models first, then chat models that draw: the
      // bridge picks by route, and falls back to whatever is left.
      return [
        ...list.filter((m) => m.kind === "image").map((m) => ({ id: m.id, route: "endpoint" as const })),
        ...list.filter((m) => m.kind !== "image" && m.imageOutput).map((m) => ({ id: m.id, route: "chat" as const })),
      ];
    },
  });

  const workspaceService = new WorkspaceService(automations.sshHosts);
  const github = new GitHubService();
  let desktopRepoManager: RepoManager | null = null;
  const emitRepoProgress = (e: RepoProgressEvent): void => broadcast(CH.repoProgress, e);

  // Watches .git for external changes (terminal/agent) and pings the renderer.
  const gitWatcher = new GitWatcher(() => broadcast(CH.gitChanged, undefined));

  const broadcastLocation = (state: WorkspaceState): void => {
    broadcast(CH.workspaceLocationChanged, state);
  };

  /* Workspace root changes fan out to the index, capability scanner, and renderer. */
  const applyWorkspaceRoot = (root: string | null): void => {
    if (!root) {
      void workspaceService.disconnect().then(broadcastLocation);
      opts.setWorkspaceRoot(null);
      projects.set({ workspaceRoot: null });
      capabilities.invalidate();
      void index.setRoot(null);
      gitWatcher.watch(null);
      broadcast(CH.workspaceRootChanged, null);
      broadcast(CH.gitChanged, undefined);
      return;
    }
    void workspaceService.setLocal(root).then((state) => {
      opts.setWorkspaceRoot(root);
      projects.set({ workspaceRoot: root });
      capabilities.invalidate();
      void index.setRoot(root);
      gitWatcher.watch(root);
      broadcast(CH.workspaceRootChanged, root);
      broadcast(CH.gitChanged, undefined);
      broadcastLocation(state);
    });
  };
  // Restore the last workspace folder so terminals/files land where the user
  // left off; the renderer re-reads the project state via projectsGet.
  const restored = projects.get().workspaceRoot;
  const activeProject = projects.get().projects.find((p) => p.id === projects.get().activeProjectId);
  const restoredLoc = activeProject ? projectLocation(activeProject) : null;
  if (restoredLoc?.kind === "remote") {
    void workspaceService.connectRemote(restoredLoc.hostId, restoredLoc.root).then((state) => {
      opts.setWorkspaceRoot(state.label);
      broadcastLocation(state);
    });
  } else if (restored) {
    void workspaceService.setLocal(restored).then((state) => {
      opts.setWorkspaceRoot(restored);
      broadcastLocation(state);
    });
  }
  void index.setRoot(restoredLoc?.kind === "remote" ? null : restored);
  gitWatcher.watch(restoredLoc?.kind === "remote" ? null : restored);

  ipcMain.handle(CH.bootstrap, async (): Promise<Bootstrap> => {
    return {
      config: {
        oauthIssuer: config.oauthIssuer,
        apiBaseUrl: config.apiBaseUrl,
        clientId: config.clientId,
      },
      user: await auth.getUser(),
      workspaceRoot: opts.getWorkspaceRoot(),
      workspaceState: workspaceService.getState(),
      version: app.getVersion(),
      platform: "desktop",
      homeDir: homedir(),
    };
  });

  ipcMain.handle(CH.authConnect, () => auth.connect());
  ipcMain.handle(CH.authLogout, () => auth.logout());
  ipcMain.handle(CH.authGetUser, () => auth.getUser());
  ipcMain.handle(CH.authGetToken, () => auth.getAccessToken());

  /* Models: served from the 1-week cache; refresh forces a live fetch. */
  ipcMain.handle(CH.modelsList, () => modelsCache.get());
  ipcMain.handle(CH.modelsRefresh, () => modelsCache.get(true));

  ipcMain.handle(CH.filesTree, (_e, dir?: string) => {
    const backend = workspaceService.getBackend();
    if (!backend) return [];
    if (!dir) return backend.readTree(undefined);
    return backend.readTree(dir);
  });
  ipcMain.handle(CH.filesRead, (_e, path: string) => {
    const backend = workspaceService.getBackend();
    if (!backend) throw new Error("No workspace open");
    return backend.readText(path);
  });
  ipcMain.handle(CH.filesWrite, (_e, path: string, content: string) => {
    const backend = workspaceService.getBackend();
    if (!backend) throw new Error("No workspace open");
    return backend.writeText(path, content);
  });

  /* Git: system-`git` via host-core, scoped to the workspace root. Read ops degrade
     gracefully (no root / not a repo → empty); mutations re-broadcast gitChanged. */
  const gitRoot = (): string | null => workspaceService.execRoot();
  const remoteGit = () => workspaceService.getRemoteGit();

  ipcMain.handle(CH.gitInfo, (): Promise<GitRepoInfo> => {
    const rg = remoteGit();
    if (rg) return rg.repoInfo();
    const root = gitRoot();
    if (!root) return Promise.resolve({ isRepo: false, root: null, branch: null, detached: false, ahead: 0, behind: 0, remotes: [] });
    return git.repoInfo(root);
  });
  ipcMain.handle(CH.gitStatus, (): Promise<GitStatus> => {
    const rg = remoteGit();
    if (rg) return rg.status();
    const root = gitRoot();
    if (!root) return Promise.resolve({ branch: null, detached: false, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicts: [] });
    return git.status(root);
  });
  ipcMain.handle(CH.gitBranches, (): Promise<GitBranch[]> => {
    const rg = remoteGit();
    if (rg) return rg.branches();
    const root = gitRoot();
    return root ? git.branches(root) : Promise.resolve([]);
  });
  const gitMutate = async (run: (root: string) => Promise<GitResult>, okMsg: string): Promise<GitResultLite> => {
    const root = gitRoot();
    if (!root || workspaceService.isRemote()) return { ok: false, message: "Git mutations require a local workspace" };
    const result = await run(root);
    broadcast(CH.gitChanged, undefined);
    return { ok: result.ok, message: (result.ok ? result.stdout : result.stderr).trim() || (result.ok ? okMsg : "git command failed") };
  };
  const gitRead = <T>(run: (root: string) => Promise<T>, fallback: T): Promise<T> => {
    const root = gitRoot();
    return root && !workspaceService.isRemote() ? run(root) : Promise.resolve(fallback);
  };

  ipcMain.handle(CH.gitCheckout, (_e, name: string) => gitMutate((r) => git.checkout(r, name), `Switched to ${name}`));
  ipcMain.handle(CH.gitStage, (_e, paths: string[]) => gitMutate((r) => git.stage(r, paths), "Staged"));
  ipcMain.handle(CH.gitUnstage, (_e, paths: string[]) => gitMutate((r) => git.unstage(r, paths), "Unstaged"));
  ipcMain.handle(CH.gitDiscard, (_e, paths: string[]) => gitMutate((r) => git.discard(r, paths), "Discarded"));
  ipcMain.handle(CH.gitCommit, (_e, message: string, o?: { amend?: boolean }) => gitMutate((r) => git.commit(r, message, o), "Committed"));
  ipcMain.handle(CH.gitFetch, () => gitMutate((r) => git.fetch(r), "Fetched"));
  ipcMain.handle(CH.gitPull, (_e, o?: { rebase?: boolean }) => gitMutate((r) => git.pull(r, o), "Pulled"));
  ipcMain.handle(CH.gitPush, (_e, o?: { setUpstream?: boolean }) => gitMutate((r) => git.push(r, o), "Pushed"));
  ipcMain.handle(CH.gitCreateBranch, (_e, name: string, from?: string) => gitMutate((r) => git.createBranch(r, name, from), `Created ${name}`));
  ipcMain.handle(CH.gitDeleteBranch, (_e, name: string, force?: boolean) => gitMutate((r) => git.deleteBranch(r, name, force), `Deleted ${name}`));
  ipcMain.handle(CH.gitStashPush, (_e, message?: string, u?: boolean) => gitMutate((r) => git.stashPush(r, message, u), "Stashed"));
  ipcMain.handle(CH.gitStashPop, (_e, index?: number) => gitMutate((r) => git.stashPop(r, index), "Popped stash"));
  ipcMain.handle(CH.gitStashDrop, (_e, index: number) => gitMutate((r) => git.stashDrop(r, index), "Dropped stash"));

  ipcMain.handle(CH.gitLog, (_e, o?: { limit?: number; skip?: number; path?: string; ref?: string }) => gitRead((r) => git.log(r, o), []));
  ipcMain.handle(CH.gitShow, (_e, ref: string) =>
    gitRead((r) => git.show(r, ref), { commit: { hash: ref, shortHash: ref.slice(0, 7), subject: "", author: "", authorEmail: "", date: "", parents: [] }, files: [] }),
  );
  ipcMain.handle(CH.gitDiffFile, (_e, path: string, mode: "worktree" | "staged" | "head") =>
    gitRead((r) => git.diffFile(r, path, mode), { path, before: "", after: "", binary: false }),
  );
  ipcMain.handle(CH.gitDiffCommit, (_e, ref: string, path: string) =>
    gitRead((r) => git.diffCommit(r, ref, path), { path, before: "", after: "", binary: false }),
  );
  ipcMain.handle(CH.gitBlame, (_e, path: string) => gitRead((r) => git.blame(r, path), []));
  ipcMain.handle(CH.gitRemotes, () => gitRead((r) => git.remotes(r), []));
  ipcMain.handle(CH.gitStashList, () => gitRead((r) => git.stashList(r), []));

  ipcMain.handle(CH.workspaceOpen, async (_e, startIn?: string) => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      ...(startIn ? { defaultPath: startIn } : {}),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const root = result.filePaths[0]!;
    applyWorkspaceRoot(root);
    return root;
  });
  ipcMain.handle(CH.workspaceListDirectory, (_e, dir: string) => workspaceService.listLocalDirectory(dir));
  ipcMain.handle(CH.workspaceGetLocation, () => workspaceService.getState());
  ipcMain.handle(CH.workspaceConnectRemote, async (_e, hostId: string, remotePath: string) => {
    const hosts = automations.listSshHosts();
    const host = hosts.find((h) => h.id === hostId);
    const state = await workspaceService.connectRemote(hostId, remotePath, host?.label ?? host?.host);
    if (state.connected && state.location?.kind === "remote") {
      opts.setWorkspaceRoot(state.label);
      projects.set({ workspaceRoot: state.label });
      capabilities.invalidate();
      void index.setRoot(null);
      gitWatcher.watch(null);
      broadcast(CH.workspaceRootChanged, state.label);
      broadcast(CH.gitChanged, undefined);
    }
    broadcastLocation(state);
    return state;
  });
  ipcMain.handle(CH.workspaceDisconnectRemote, async () => {
    const state = await workspaceService.disconnect();
    opts.setWorkspaceRoot(null);
    projects.set({ workspaceRoot: null });
    broadcast(CH.workspaceRootChanged, null);
    broadcastLocation(state);
    return state;
  });
  ipcMain.handle(CH.workspaceSetRoot, (_e, root: string | null) => {
    applyWorkspaceRoot(root);
  });
  ipcMain.handle(CH.workspaceGetRoot, () => opts.getWorkspaceRoot());

  ipcMain.handle(CH.projectsGet, () => projects.get());
  ipcMain.handle(CH.projectsSet, (_e, patch: Partial<ProjectsState>) => projects.set(patch));

  ipcMain.handle(CH.termCreate, (e, options: TerminalCreateOptions) => {
    const shellId = options.shell ?? settings.get().defaultShell ?? undefined;
    const id = terminals.create({ ...options, shell: shellId });
    termSenders.set(Number(id), e.sender);
    return id;
  });
  ipcMain.handle(CH.termAttach, (e, id: string) => {
    termSenders.set(Number(id), e.sender);
    return terminals.attach(id);
  });
  ipcMain.on(CH.termWrite, (_e, id: string, data: string) => terminals.write(id, data));
  ipcMain.on(CH.termResize, (_e, id: string, cols: number, rows: number) => terminals.resize(id, cols, rows));
  ipcMain.on(CH.termKill, (_e, id: string) => terminals.kill(id));

  ipcMain.handle(CH.envDetect, () => detectEnv());

  ipcMain.handle(CH.settingsGet, () => settings.get());
  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<DeyinSettings>) => {
    const next = settings.set(patch);
    if ("indexingEnabled" in patch) void index.refresh();
    if ("automationsCatchUp" in patch || "keepRunningInBackground" in patch) {
      automations.refreshScheduler();
    }
    return next;
  });

  ipcMain.handle(CH.computerUseGetAllowlist, () => computerUse.getAllowlist());
  ipcMain.handle(CH.computerUseSetAllowlist, (_e, apps: string[]) => {
    computerUse.setAllowlist(apps);
    return computerUse.getAllowlist();
  });
  ipcMain.handle(CH.computerUseListApps, () => computerUse.listAppsPreview());
  ipcMain.handle(CH.computerUseGetHostStatus, () => computerUse.getHostStatus());
  ipcMain.on(CH.computerUseAppApprovalRespond, (_e, requestId: string, decision: "always" | "once" | "deny") => {
    const pending = pendingAppApprovals.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingAppApprovals.delete(requestId);
    pending.resolve(decision);
  });

  /* Capabilities: live registry + persisted disabled set. */
  ipcMain.handle(CH.capsList, (_e, kind?: CapabilityKind) => capabilities.listItems(kind));
  ipcMain.handle(CH.capsToggle, async (_e, id: string, enabled: boolean) => {
    capabilities.toggle(id, enabled);
    return capabilities.listItems();
  });

  /* MCP settings surface. */
  ipcMain.handle(CH.mcpList, () => capabilities.listMcpServers());
  ipcMain.handle(CH.mcpAdd, async (_e, input: McpServerInput) => {
    capabilities.addMcpServer(input);
    return capabilities.listMcpServers();
  });
  ipcMain.handle(CH.mcpRemove, async (_e, name: string) => {
    capabilities.removeMcpServer(name);
    return capabilities.listMcpServers();
  });
  ipcMain.handle(CH.mcpTest, (_e, name: string) => capabilities.testMcpServer(name));

  /* MCP catalog / modules / native OAuth. */
  ipcMain.handle(CH.mcpCatalogList, () => mcpCatalog.list());
  ipcMain.handle(CH.mcpCatalogInstall, (_e, input: import("@deyin/contract").McpCatalogInstallInput) => {
    mcpCatalog.install(input);
    return capabilities.listMcpServers();
  });
  ipcMain.handle(CH.mcpModulesList, () => mcpModules.list());
  ipcMain.handle(CH.mcpModulesUninstall, (_e, id: string) => {
    mcpModules.uninstall(id);
    return capabilities.listMcpServers();
  });
  ipcMain.handle(CH.mcpAuthenticate, async (_e, moduleId: string) => {
    const result = await mcpOAuth.authenticate(moduleId, moduleMcpUrl(moduleId));
    // Pooled clients still hold the pre-auth credential; drop them so the next
    // run reconnects with the token that was just granted.
    agentHost.resetMcpConnections();
    return result;
  });
  ipcMain.handle(CH.mcpAuthRevoke, (_e, moduleId: string) => {
    mcpOAuth.revoke(moduleId);
    agentHost.resetMcpConnections();
    return undefined;
  });
  ipcMain.handle(CH.mcpAuthStatus, () => mcpOAuth.statusForModules(mcpModules.list()));

  /* @ context attachments. */
  ipcMain.handle(CH.contextSearch, (_e, query: string) => searchContextPaths(opts.getWorkspaceRoot(), query));
  ipcMain.handle(CH.contextResolve, (_e, refs: import("@deyin/contract").ContextRef[]) =>
    resolveContextRefs(opts.getWorkspaceRoot(), Array.isArray(refs) ? refs : []),
  );

  /* Change review queue. */
  ipcMain.handle(CH.reviewList, (_e, threadId?: string) => (threadId ? review.list(threadId) : review.listAll()));
  ipcMain.handle(CH.reviewApprove, (e, threadId: string, changeId: string) => {
    const ok = review.approve(threadId, changeId, e.sender.id);
    if (ok) broadcastReviewResolved(threadId, changeId, "approved");
    return ok;
  });
  ipcMain.handle(CH.reviewReject, (e, threadId: string, changeId: string) => {
    const ok = review.reject(threadId, changeId, e.sender.id);
    if (ok) broadcastReviewResolved(threadId, changeId, "rejected");
    return ok;
  });
  ipcMain.handle(CH.reviewApproveAll, async (e, threadId: string) => {
    const ids = await review.approveAll(threadId, e.sender.id);
    for (const id of ids) broadcastReviewResolved(threadId, id, "approved");
    return ids.length;
  });
  ipcMain.handle(CH.reviewRejectAll, (e, threadId: string) => {
    const ids = review.rejectAll(threadId, e.sender.id);
    for (const id of ids) broadcastReviewResolved(threadId, id, "rejected");
    return ids.length;
  });

  /* Security findings. */
  ipcMain.handle(CH.securityListFindings, (_e, threadId: string) => security.listFindings(threadId));
  ipcMain.handle(CH.securityClearFindings, (_e, threadId: string) => security.clearFindings(threadId));
  ipcMain.handle(CH.securityScanDiff, async (_e, threadId: string, diff: string) => {
    const report = await scanDiffViaMcp(capabilities, opts.getWorkspaceRoot(), diff);
    const merged = security.mergeReport(threadId, report);
    broadcast(CH.securityFindingsChanged, threadId);
    return merged;
  });

  /* Billing (Openference OAuth-backed). */
  const billingOpts = { oauthIssuer: config.oauthIssuer };
  ipcMain.handle(CH.billingOverview, () => fetchBillingOverview(billingOpts, () => auth.getAccessToken()));
  ipcMain.handle(CH.billingSelectPlan, (_e, planId: number, options?: import("@deyin/contract").SelectPlanOptions) =>
    selectPlan(billingOpts, () => auth.getAccessToken(), planId, options),
  );
  ipcMain.handle(CH.billingPublishableKey, () => fetchBillingPublishableKey(billingOpts, () => auth.getAccessToken()));
  ipcMain.handle(CH.billingCompleteCrossCurrency, (_e, newSubscriptionId: string) =>
    completeCrossCurrencyUpgrade(billingOpts, () => auth.getAccessToken(), newSubscriptionId),
  );
  ipcMain.handle(CH.billingAbortCrossCurrency, (_e, newSubscriptionId: string) =>
    abortCrossCurrencyUpgrade(billingOpts, () => auth.getAccessToken(), newSubscriptionId),
  );

  /* Visualizations. */
  ipcMain.handle(CH.visualizeRead, (_e, threadId: string, fileName: string) => visualize.readFragment(threadId, fileName));
  ipcMain.handle(CH.pageRead, (_e, threadId: string, fileName: string) => pages.readPage(threadId, fileName));

  /* Generated images: store, read back as a data URL, and run a model directly. */
  ipcMain.handle(CH.imagesSave, (_e, threadId: string, input: { base64: string; mediaType?: string }) => ({
    file: images.save(threadId, input).file,
  }));
  ipcMain.handle(CH.imagesRead, (_e, threadId: string, fileName: string) => imageDataUrl(images.read(threadId, fileName)));
  ipcMain.handle(CH.imagesGenerate, (_e, request: ImageGenerateRequest) =>
    runImageGeneration(images, imageRouting(request.providerId), request),
  );

  /* Local Vision plugin (Ollama + moondream). */
  ipcMain.handle(CH.visionDescribeLocal, (_e, images: AgentImageInput[], userText?: string) =>
    localVision.describeLocal(images, userText),
  );
  ipcMain.handle(CH.visionLocalStatus, () => localVision.status());

  /* Beta feedback: best-effort upload to the Openference backend. */
  ipcMain.handle(
    CH.betaFeedbackSubmit,
    async (_e, payload: { category: string; message: string; rating?: number }): Promise<{ ok: boolean }> => {
      try {
        const token = await auth.getAccessToken();
        const res = await fetch(`${config.oauthIssuer.replace(/\/$/, "")}/api/beta/feedback`, {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            category: String(payload.category).slice(0, 100),
            message: String(payload.message).slice(0, 8000),
            rating: typeof payload.rating === "number" ? payload.rating : undefined,
          }),
        });
        return { ok: res.ok };
      } catch {
        return { ok: false };
      }
    },
  );

  /* Plugins. */
  ipcMain.handle(CH.pluginsList, () => plugins.list());
  ipcMain.handle(CH.pluginsKernelStatus, async () => {
    // Kick kernel creation so the page reflects real rows even before a first run.
    const kernel = await agentHost.kernelReady();
    return kernel.status();
  });
  ipcMain.handle(CH.pluginsCatalog, (_e, force?: boolean) => plugins.catalog(force));
  ipcMain.handle(CH.pluginsInstall, async (_e, source: string) => {
    const result = await plugins.install(source);
    telemetry.record("plugin-install", { ok: result.ok });
    return result;
  });
  ipcMain.handle(CH.pluginsUninstall, (_e, name: string) => plugins.uninstall(name));
  ipcMain.handle(CH.pluginsSetVariable, (_e, plugin: string, name: string, value: string) =>
    plugins.setVariable(plugin, name, value),
  );
  ipcMain.handle(CH.pluginsVariableState, (_e, plugin: string, names: string[]) => plugins.variableState(plugin, names));

  /* Indexing. */
  ipcMain.handle(CH.indexStatus, () => index.status());
  ipcMain.handle(CH.indexRebuild, () => index.rebuild());
  ipcMain.handle(CH.indexSearch, (_e, query: string, topK?: number) => index.search(query, Math.min(topK ?? 8, 20)));

  /* Agent runtime. */
  ipcMain.handle(CH.agentStart, (_e, options: AgentStartOptions) => {
    telemetry.record("agent-run");
    void agentHost.start(options).catch((err) => {
      console.error("[deyin] agent start failed:", err);
      agentHost.sendStartupError(options.threadId, err);
    });
  });
ipcMain.on(CH.agentStop, (_e, threadId: string) => agentHost.stop(threadId));
ipcMain.on(CH.agentApprove, (_e, requestId: string, decision: PermissionDecision) =>
 agentHost.approve(requestId, decision),
);
ipcMain.on(CH.workspaceTrustRespond, (_e, requestId: string, decision: "trust" | "skip") =>
  agentHost.respondTrust(requestId, decision),
);
ipcMain.on(CH.agentAnswerQuestion, (_e, requestId: string, answers: Record<string, string | string[]>) =>
 agentHost.answerQuestion(requestId, answers),
);
ipcMain.on(CH.agentDisposeShell, (_e, threadId: string) => agentHost.disposeShell(threadId));

  /* Browser control plumbing. */
  ipcMain.on(CH.browserRegister, (e, webContentsId: number | null) => browser.register(webContentsId ?? e.sender.id));
  ipcMain.on(CH.browserTabSync, (_e, webContentsId: number, url: string, title: string) =>
    browser.syncTab(webContentsId, url, title),
  );
  ipcMain.on(CH.browserTabRemove, (_e, webContentsId: number) => browser.removeTab(webContentsId));
  ipcMain.handle(CH.browserGetPartition, () => workspacePartition(opts.getWorkspaceRoot()));
  ipcMain.handle(CH.browserClearProfile, () => browser.clearProfile());

  const providersSnapshot = async () => agents.listProviders((await auth.getUser()) != null);
  ipcMain.handle(CH.providersList, providersSnapshot);
  ipcMain.handle(CH.providersAdd, async (_e, input: { name: string; baseUrl: string }) => {
    agents.addProvider(input);
    return providersSnapshot();
  });
  ipcMain.handle(CH.providersUpdate, async (_e, id: string, patch: ProviderPatch) => {
    agents.updateProvider(id, patch);
    return providersSnapshot();
  });
  ipcMain.handle(CH.providersRemove, async (_e, id: string) => {
    agents.removeProvider(id);
    return providersSnapshot();
  });
  ipcMain.handle(CH.providersSetKey, async (_e, id: string, key: string) => {
    agents.setKey(id, key);
    return providersSnapshot();
  });
  ipcMain.handle(CH.providersGetKey, (_e, id: string) => agents.getKey(id));
  ipcMain.handle(CH.providersTest, (_e, id: string) => agents.testProvider(id));
  ipcMain.handle(CH.providersFetchModels, (_e, id: string) => agents.fetchModels(id));

  ipcMain.handle(CH.usageGet, () => usage.stats());
  ipcMain.handle(CH.usageRecord, (_e, event: UsageEvent) => usage.record(event));
  ipcMain.handle(CH.usageAccount, (_e, force?: boolean) => accountCache.get(force ?? false));
  ipcMain.handle(CH.plansList, () => fetchPublicPlans({ oauthIssuer: config.oauthIssuer }));
  ipcMain.handle(CH.plansReleaseStatus, () => fetchReleaseStatus({ oauthIssuer: config.oauthIssuer }));

  /* Telemetry (renderer-side feature events). */
  ipcMain.on(CH.telemetryRecord, (_e, name: string, props?: Record<string, string | number | boolean>) =>
    telemetry.record(name, props),
  );

  ipcMain.on(CH.winMinimize, (e) => windowOf(e)?.minimize());
  ipcMain.on(CH.winToggleMaximize, (e) => {
    const win = windowOf(e);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on(CH.winClose, (e) => windowOf(e)?.close());

  ipcMain.handle(CH.browserClearCache, () => session.defaultSession.clearCache());
  ipcMain.handle(CH.browserClearAll, async () => {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData();
  });

  ipcMain.handle(CH.searchQuery, (_e, q: string) => webSearch(q));

  ipcMain.on(CH.shellShowItem, (_e, path: string) => shell.showItemInFolder(path));
  ipcMain.on(CH.shellOpenExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  ipcMain.handle(CH.pathsGet, () => {
    const userData = app.getPath("userData");
    return {
      userData,
      logs: app.getPath("logs"),
      config: join(userData, "settings.json"),
    };
  });

  /* Identity & access. */
  ipcMain.handle(CH.identityGet, () => identity.info());
  ipcMain.handle(CH.identitySync, () => identity.sync());

  /* Diagnostics upload + renderer log forwarding. */
  ipcMain.handle(CH.diagnosticsSend, (_e, note?: string) => diagnostics.send(note));
  ipcMain.on(CH.logWrite, (_e, level: "info" | "warn" | "error", message: string) => {
    if (typeof message === "string" && message.length > 0) logLine(level, `[renderer] ${message.slice(0, 4000)}`);
  });

  /* Automations ----------------------------------------------------------- */
  ipcMain.handle(CH.automationsList, () => automations.list());
  ipcMain.handle(CH.automationsCreate, (_e, input: Omit<Automation, "id" | "createdAt" | "updatedAt">) =>
    automations.create(input),
  );
  ipcMain.handle(CH.automationsUpdate, (_e, id: string, patch: Partial<Omit<Automation, "id" | "createdAt">>) =>
    automations.update(id, patch),
  );
  ipcMain.handle(CH.automationsDelete, (_e, id: string) => automations.remove(id));
  ipcMain.handle(CH.automationsToggle, (_e, id: string, enabled: boolean) => automations.toggle(id, enabled));
  ipcMain.handle(CH.automationsRun, (_e, id: string) => automations.run(id));
  ipcMain.on(CH.automationsStop, (_e, runId: string) => automations.stopRun(runId));
  ipcMain.handle(CH.automationsRuns, (_e, automationId?: string) => automations.listRuns(automationId));
  ipcMain.handle(CH.wslTestDistro, (_e, distro: string) => testWslDistro(distro));

  /* SSH hosts (remote automation targets) --------------------------------- */
  ipcMain.handle(CH.sshHostsList, () => automations.listSshHosts());
  ipcMain.handle(CH.sshHostsAdd, (_e, input: SshHostInput) => automations.addSshHost(input));
  ipcMain.handle(CH.sshHostsUpdate, (_e, id: string, patch: Partial<SshHostInput>) =>
    automations.updateSshHost(id, patch),
  );
  ipcMain.handle(CH.sshHostsRemove, (_e, id: string) => automations.removeSshHost(id));
  ipcMain.handle(CH.sshHostsSetCredentials, (_e, id: string, creds: SshHostCredentials) =>
    automations.setSshCredentials(id, creds),
  );
  ipcMain.handle(CH.sshHostsTest, (_e, hostId: string, acceptFingerprint?: string) =>
    automations.testSshHost(hostId, acceptFingerprint),
  );
  ipcMain.handle(CH.sshHostsPinFingerprint, (_e, hostId: string, fingerprint: string) =>
    automations.pinSshFingerprint(hostId, fingerprint),
  );
  ipcMain.handle(CH.sshHostsImportKey, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Private key", extensions: ["pem", "key", ""] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return readFileSync(result.filePaths[0]!, "utf8");
  });
  ipcMain.handle(CH.sshBrowse, (_e, hostId: string, remotePath: string) =>
    workspaceService.listRemoteDirectory(hostId, remotePath),
  );

  ipcMain.handle(CH.repoConnect, async (_e, req: RepoConnectRequest) => {
    const { slugifyRepo } = await import("@deyin/host-core");
    const slug = slugifyRepo(req.url);
    const cloneDir = pathJoin(defaultCloneRoot(), `${slug}-${randomBytes(3).toString("hex")}`);
    try {
      mkdirSync(cloneDir, { recursive: true });
      const user = await auth.getUser();
      desktopRepoManager = new RepoManager(
        cloneDir,
        { name: user?.name ?? undefined, email: user?.email ?? undefined },
        (stage, line) => emitRepoProgress({ stage, line }),
      );
      const token = req.token ?? github.getToken() ?? undefined;
      const state = await desktopRepoManager.connect({ ...req, token });
      applyWorkspaceRoot(cloneDir);
      return state;
    } catch (err) {
      try {
        const { rmSync } = await import("node:fs");
        rmSync(cloneDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      throw err;
    }
  });
  ipcMain.handle(CH.repoState, () => desktopRepoManager?.state() ?? { connected: false, url: null, branch: null, defaultBranch: null });

  ipcMain.handle(CH.githubConnect, () => github.connect());
  ipcMain.handle(CH.githubDisconnect, () => {
    github.disconnect();
  });
  ipcMain.handle(CH.githubAuthState, () => github.authState());
  ipcMain.handle(CH.githubListRepos, (_e, query?: string) => github.listRepos(query));

  return {
    terminals,
    shouldKeepRunningInBackground: () => settings.get().keepRunningInBackground,
    notifyAuthChanged: () => {
      accountCache.invalidate();
      modelsCache.invalidate();
      // Register this workstation under the fresh session (or clear sync state
      // on logout by simply not syncing — lastSyncedAt stays historical).
      void auth.getUser().then((user) => {
        if (user) void identity.sync();
      });
    },
    shutdown: async () => {
      // Abort in-flight agent runs first so MCP children observe the signal.
      agentHost.stopAll();
      automations.dispose();
      // Also hangs up the pooled MCP servers, which now outlive a single run.
      await agentHost.dispose();
      telemetry.stop();
      await Promise.race([
        telemetry.flush(),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      // Writes are async and coalescing; don't quit with settings/projects still queued.
      await Promise.race([
        storage.flush(),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      index.dispose();
      gitWatcher.stop();
      workspaceService.dispose();
    },
  };
}
