import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, app, dialog, ipcMain, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
  AccountCache,
  AgentsStore,
  IndexManager,
  ModelsCache,
  ProjectsStore,
  SettingsStore,
  TelemetryReporter,
  TerminalManager,
  UsageStore,
  assertInsideRoot,
  detectEnv,
  readTextFile,
  readTree,
  writeTextFile,
  webSearch,
  searchContextPaths,
  resolveContextRefs,
  gitStatus,
  gitDiff,
  gitStage,
  gitCommit,
  gitBranches,
  gitCheckout,
  gitLog,
  isGitRepo,
} from "@deyin/host-core";
import { fetchPublicPlans, selectPlan, fetchBillingOverview, fetchBillingPublishableKey, completeCrossCurrencyUpgrade, abortCrossCurrencyUpgrade, ReasonixMetricsStore, emptyReasonixMetrics, type ReasonixMetricsSnapshot } from "@deyin/host-core/shared";
import type { PermissionDecision } from "@deyin/agent-core";
import { CH } from "../shared/ipc.js";
import type {
  AgentStartOptions,
  Bootstrap,
  CapabilityKind,
  DeyinSettings,
  McpServerInput,
  McpCatalogInstallInput,
  ProjectsState,
  ProviderPatch,
  TerminalCreateOptions,
  UsageEvent,
} from "../shared/types.js";
import type { DeyinConfig } from "../shared/config.js";
import { DesktopAgentHost } from "./agent.js";
import { setTrayPendingReviewCount } from "./tray.js";
import type { AuthManager } from "./auth.js";
import { BrowserControlService, workspacePartition } from "./browser.js";
import { ChromeDebugService } from "./chrome-debug.js";
import { ComputerUseService } from "./computer-use.js";
import { VisualizeService } from "./visualize.js";
import { SecurityService } from "./security.js";
import { scanDiffViaMcp } from "./security-scan.js";
import { CapabilityService } from "./capabilities.js";
import { McpCatalogService } from "./mcp-catalog.js";
import { McpModuleService } from "./mcp-modules.js";
import { McpOAuthService } from "./mcp-oauth.js";
import { DiagnosticsService } from "./diagnostics.js";
import { IdentityService } from "./identity.js";
import { logLine } from "./logger.js";
import { PluginService, resolveBundledPluginsDir } from "./plugins.js";
import { createDesktopStorage } from "./storage.js";
import { createUpdateController } from "./updater.js";
import { AutomationService } from "./automations/service.js";
import type { AgentRunContextDeps } from "./automations/agent-run-context.js";
import { readFileSync, appendFileSync } from "node:fs";
import { reasonixObservability } from "./reasonix-observability.js";

interface RegisterOptions {
  config: DeyinConfig;
  auth: AuthManager;
  getWorkspaceRoot: () => string | null;
  setWorkspaceRoot: (root: string | null) => void;
}

export interface IpcServices {
  terminals: TerminalManager;
  automations: AutomationService;
  shouldKeepRunningInBackground: () => boolean;
  /** Call when the auth session changes (login/logout) to drop server caches. */
  notifyAuthChanged: () => void;
  dispose: () => void;
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

  const reasonixMetrics = new ReasonixMetricsStore((data: ReasonixMetricsSnapshot) => {
    storage.writeJson("reasonix-metrics.json", data);
  }, storage.readJson<ReasonixMetricsSnapshot>("reasonix-metrics.json", emptyReasonixMetrics()));

  /* Weekly metrics report (best effort; logged locally). */
  const metricsReportTimer = setInterval(() => {
    const report = reasonixMetrics.generateWeeklyReport();
    logLine("info", `[reasonix-metrics] weekly ${report.weekBucket}: cache=${(report.snapshot.cache.hitRate * 100).toFixed(1)}% coordinator=${report.snapshot.coordinator.runs} fleet=${report.snapshot.fleet.runs}`);
    storage.writeJson(`reasonix-weekly-${report.weekBucket}.json`, report);
  }, 7 * 24 * 60 * 60 * 1000);
  (metricsReportTimer as { unref?: () => void }).unref?.();

  /* Updates. */
  const updates = createUpdateController({
    isAutoUpdateEnabled: () => settings.get().autoUpdate,
  });
  ipcMain.handle(CH.updatesGetState, () => updates.getState());
  ipcMain.handle(CH.updatesCheck, () => updates.check());
  ipcMain.handle(CH.updatesDownload, () => updates.download());
  ipcMain.on(CH.updatesInstall, () => updates.install());
  // Always poll on launch so users with auto-update off still see the banner;
  // download stays gated by settings.autoUpdate / explicit Download click.
  void updates.check();

  /* Capabilities, plugins, browser control, indexing, agent runtime. */
  const pluginsDir = join(app.getPath("userData"), "plugins");
  const builtinSkillsDir = join(app.getPath("userData"), "builtin-skills");
  const bundledPluginsDir = resolveBundledPluginsDir(app.getAppPath(), app.isPackaged, process.resourcesPath);
  const capabilities = new CapabilityService(agents, opts.getWorkspaceRoot, pluginsDir, builtinSkillsDir);
  const mcpModules = new McpModuleService(homedir(), () => capabilities.invalidate());
  const mcpOAuth = new McpOAuthService();
  capabilities.setMcpModules(mcpModules);
  capabilities.setMcpOAuth(mcpOAuth);
  const migrated = mcpModules.migrateFlatMcp();
  if (migrated > 0) logLine("info", `Migrated ${migrated} MCP server(s) to ~/.deyin/mcp-modules/`);
  const mcpCatalog = new McpCatalogService(mcpModules);
  const plugins = new PluginService(pluginsDir, storage, agents, capabilities, bundledPluginsDir);
  let chromeConsentResolver: ((granted: boolean) => void) | null = null;
  const browser = new BrowserControlService(opts.getWorkspaceRoot, () => settings.get().browserControlEnabled);
  const chrome = new ChromeDebugService(
    () => settings.get().chromeDebugEnabled,
    () => process.platform === "win32",
    () =>
      new Promise<boolean>((resolve) => {
        broadcast(CH.chromeConsentRequest, {
          message: "Deyin will control your Chrome browser including logged-in sites. Allow this session?",
        });
        chromeConsentResolver = resolve;
      }),
    app.getPath("userData"),
  );
  ipcMain.on(CH.chromeConsentRespond, (_e, granted: boolean) => {
    chromeConsentResolver?.(Boolean(granted));
    chromeConsentResolver = null;
  });
  const computerUse = new ComputerUseService(
    () => settings.get().computerUseEnabled,
    () => process.platform === "win32",
    () => settings.get().computerUseScreenshotRetentionDays,
  );
  computerUse.registerShortcuts();
  const visualize = new VisualizeService();
  const security = new SecurityService();

  const index = new IndexManager({
    indexRoot: join(app.getPath("userData"), "index"),
    modelCacheDir: join(app.getPath("userData"), "models"),
    isEnabled: () => settings.get().indexingEnabled,
    onStatus: (status) => broadcast(CH.indexStatusEvent, status),
  });

  const sender = () =>
    BrowserWindow.getFocusedWindow()?.webContents ?? BrowserWindow.getAllWindows()[0]?.webContents ?? null;
  const terminals = new TerminalManager({
    onData: (id, data) => sender()?.send(CH.termData, { id, data }),
    onExit: (id, exitCode) => sender()?.send(CH.termExit, { id, exitCode }),
  });

  const agentHost = new DesktopAgentHost({
    config,
    auth,
    agents,
    settings,
    capabilities,
    browser,
    chrome,
    computerUse,
    visualize,
    security,
    terminals,
    getWorkspaceRoot: opts.getWorkspaceRoot,
    searchIndex: (query, topK) => index.search(query, topK),
    getContextLength: (providerId, modelId) => {
      const provider = agents.listProviders(true).find((p) => p.id === providerId);
      const fromProvider = provider?.models.find((m) => m.id === modelId)?.contextLength;
      if (fromProvider) return fromProvider;
      // Primary Openference catalog lives in ModelsCache (provider.models is often empty).
      return modelsCache.listCached().find((m) => m.id === modelId)?.contextLength;
    },
    onPendingReviewChanged: (count) => setTrayPendingReviewCount(count),
    reasonixMetrics,
  });

  const agentDeps: AgentRunContextDeps = {
    config,
    auth,
    agents,
    settings,
    capabilities,
    browser,
    chrome,
    computerUse,
    visualize,
    getWorkspaceRoot: opts.getWorkspaceRoot,
    searchIndex: (query, topK) => index.search(query, topK),
    getContextLength: (providerId, modelId) => {
      const provider = agents.listProviders(true).find((p) => p.id === providerId);
      const fromProvider = provider?.models.find((m) => m.id === modelId)?.contextLength;
      if (fromProvider) return fromProvider;
      return modelsCache.listCached().find((m) => m.id === modelId)?.contextLength;
    },
  };

  const automations = new AutomationService({
    storage,
    deps: agentDeps,
    auth,
    isCatchUpEnabled: () => settings.get().automationsCatchUp,
  });

  /* Workspace root changes fan out to the index, capability scanner, and renderer. */
  const applyWorkspaceRoot = (root: string | null): void => {
    opts.setWorkspaceRoot(root);
    projects.set({ workspaceRoot: root });
    capabilities.invalidate();
    void index.setRoot(root);
    broadcast(CH.workspaceRootChanged, root);
  };
  // Restore the last workspace folder so terminals/files land where the user
  // left off; the renderer re-reads the project state via projectsGet.
  opts.setWorkspaceRoot(projects.get().workspaceRoot);
  void index.setRoot(projects.get().workspaceRoot);

  ipcMain.handle(CH.bootstrap, async (): Promise<Bootstrap> => {
    return {
      config: {
        oauthIssuer: config.oauthIssuer,
        apiBaseUrl: config.apiBaseUrl,
        clientId: config.clientId,
      },
      user: await auth.getUser(),
      workspaceRoot: opts.getWorkspaceRoot(),
      version: app.getVersion(),
      platform: "desktop",
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
    const root = opts.getWorkspaceRoot();
    if (!root) return [];
    if (!dir) return readTree(root);
    return readTree(assertInsideRoot(root, dir));
  });
  ipcMain.handle(CH.filesRead, (_e, path: string) => {
    const root = opts.getWorkspaceRoot();
    if (!root) throw new Error("No workspace open");
    return readTextFile(assertInsideRoot(root, path));
  });
  ipcMain.handle(CH.filesWrite, (_e, path: string, content: string) => {
    const root = opts.getWorkspaceRoot();
    if (!root) throw new Error("No workspace open");
    return writeTextFile(assertInsideRoot(root, path), content);
  });

  ipcMain.handle(CH.workspaceOpen, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    const root = result.filePaths[0]!;
    applyWorkspaceRoot(root);
    return root;
  });
  ipcMain.handle(CH.workspaceSetRoot, (_e, root: string | null) => {
    applyWorkspaceRoot(root);
  });
  ipcMain.handle(CH.workspaceGetRoot, () => opts.getWorkspaceRoot());

  ipcMain.handle(CH.projectsGet, () => projects.get());
  ipcMain.handle(CH.projectsSet, (_e, patch: Partial<ProjectsState>) => projects.set(patch));

  ipcMain.handle(CH.termCreate, (_e, options: TerminalCreateOptions) => {
    const shellId = options.shell ?? settings.get().defaultShell ?? undefined;
    return terminals.create({ ...options, shell: shellId });
  });
  ipcMain.handle(CH.termAttach, (_e, id: string) => terminals.attach(id));
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
  ipcMain.handle(CH.mcpCatalogList, () => mcpCatalog.list());
  ipcMain.handle(CH.mcpCatalogInstall, async (_e, input: McpCatalogInstallInput) => {
    mcpCatalog.install(input);
    return capabilities.listMcpServers();
  });
  ipcMain.handle(CH.mcpModulesList, () => mcpModules.list());
  ipcMain.handle(CH.mcpModulesUninstall, async (_e, id: string) => {
    mcpModules.uninstall(id);
    mcpOAuth.revoke(id);
    return capabilities.listMcpServers();
  });
  ipcMain.handle(CH.mcpAuthenticate, async (_e, moduleId: string) => {
    const manifest = mcpModules.get(moduleId);
    if (!manifest) throw new Error(`Unknown MCP module "${moduleId}".`);
    const mcpFile = join(mcpModules.moduleDir(moduleId), "mcp.json");
    let url: string | undefined;
    try {
      const parsed = JSON.parse(readFileSync(mcpFile, "utf8")) as {
        mcpServers?: Record<string, { url?: string }>;
      };
      url = parsed.mcpServers?.[moduleId]?.url;
    } catch {
      // fall through
    }
    if (!url?.trim()) throw new Error(`Module "${moduleId}" has no remote MCP URL.`);
    return mcpOAuth.authenticate(moduleId, url);
  });
  ipcMain.handle(CH.mcpAuthRevoke, (_e, moduleId: string) => {
    mcpOAuth.revoke(moduleId);
  });
  ipcMain.handle(CH.mcpAuthStatus, () => mcpOAuth.statusForModules(mcpModules.list()));

  /* Plugins. */
  ipcMain.handle(CH.pluginsList, () => plugins.list());
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
  ipcMain.handle(CH.agentStart, (event, options: AgentStartOptions) => {
    telemetry.record("agent-run");
    void agentHost.start(options, event.sender.id);
  });
ipcMain.on(CH.agentStop, (_e, threadId: string) => agentHost.stop(threadId));
ipcMain.on(CH.agentApprove, (_e, requestId: string, decision: PermissionDecision) =>
 agentHost.approve(requestId, decision),
);
ipcMain.on(CH.agentAnswerQuestion, (_e, requestId: string, answers: Record<string, string | string[]>) =>
 agentHost.answerQuestion(requestId, answers),
);
ipcMain.on(CH.agentDisposeShell, (_e, threadId: string) => agentHost.disposeShell(threadId));

  ipcMain.handle(CH.contextSearch, (_e, query: string) =>
    searchContextPaths(opts.getWorkspaceRoot(), query),
  );
  ipcMain.handle(CH.contextResolve, (_e, refs: import("../shared/types.js").ContextRef[]) =>
    resolveContextRefs(opts.getWorkspaceRoot(), refs),
  );

  ipcMain.handle(CH.reviewList, (_e, threadId?: string) => agentHost.listPendingChanges(threadId));
  ipcMain.handle(CH.reviewApprove, (event, threadId: string, changeId: string) =>
    agentHost.approvePendingChange(threadId, changeId, event.sender.id),
  );
  ipcMain.handle(CH.reviewReject, (event, threadId: string, changeId: string) =>
    agentHost.rejectPendingChange(threadId, changeId, event.sender.id),
  );
  ipcMain.handle(CH.reviewApproveAll, (event, threadId: string) =>
    agentHost.approveAllPendingChanges(threadId, event.sender.id),
  );
  ipcMain.handle(CH.reviewRejectAll, (event, threadId: string) =>
    agentHost.rejectAllPendingChanges(threadId, event.sender.id),
  );

  ipcMain.handle(CH.gitStatus, async () => {
    const root = opts.getWorkspaceRoot();
    if (!root || !(await isGitRepo(root))) return null;
    return gitStatus(root);
  });
  ipcMain.handle(CH.gitDiff, async (_e, path?: string, staged?: boolean) => {
    const root = opts.getWorkspaceRoot();
    if (!root) throw new Error("No workspace open");
    return gitDiff(root, path, staged);
  });
  ipcMain.handle(CH.gitStage, async (_e, paths: string[], unstage?: boolean) => {
    const root = opts.getWorkspaceRoot();
    if (!root) throw new Error("No workspace open");
    return gitStage(root, paths, unstage);
  });
  ipcMain.handle(CH.gitCommit, async (_e, message: string) => {
    const root = opts.getWorkspaceRoot();
    if (!root) throw new Error("No workspace open");
    return gitCommit(root, message);
  });
  ipcMain.handle(CH.gitBranches, async () => {
    const root = opts.getWorkspaceRoot();
    if (!root) return [];
    return gitBranches(root);
  });
  ipcMain.handle(CH.gitCheckout, async (_e, branch: string) => {
    const root = opts.getWorkspaceRoot();
    if (!root) throw new Error("No workspace open");
    return gitCheckout(root, branch);
  });
  ipcMain.handle(CH.gitLog, async (_e, limit?: number) => {
    const root = opts.getWorkspaceRoot();
    if (!root) return [];
    return gitLog(root, limit);
  });

  /* Browser control plumbing. */
  ipcMain.on(CH.browserRegister, (_e, webContentsId: number | null) => browser.register(webContentsId));
  ipcMain.on(CH.browserTabSync, (_e, webContentsId: number, url: string, title: string) =>
    browser.syncTab(webContentsId, url, title),
  );
  ipcMain.on(CH.browserTabRemove, (_e, webContentsId: number) => browser.removeTab(webContentsId));
  ipcMain.handle(CH.browserGetPartition, () => workspacePartition(opts.getWorkspaceRoot()));
  ipcMain.handle(CH.browserClearProfile, () => browser.clearProfile());
  ipcMain.handle(CH.computerUseGetAllowlist, () => computerUse.getAllowlist());
  ipcMain.handle(CH.computerUseSetAllowlist, (_e, apps: string[]) => {
    computerUse.setAllowlist(apps);
  });
  ipcMain.handle(CH.computerUseListApps, () => computerUse.listAppsPreview());
  ipcMain.handle(CH.visualizeRead, (_e, threadId: string, fileName: string) => visualize.readFragment(threadId, fileName));

  ipcMain.handle(CH.securityListFindings, (_e, threadId: string) => security.listFindings(threadId));
  ipcMain.handle(CH.securityClearFindings, (_e, threadId: string) => {
    security.clearFindings(threadId);
    broadcast(CH.securityFindingsChanged, threadId);
  });
  ipcMain.handle(CH.securityScanDiff, async (_e, threadId: string, diff: string) => {
    const report = await scanDiffViaMcp(capabilities, opts.getWorkspaceRoot(), diff);
    security.mergeReport(threadId, report);
    broadcast(CH.securityFindingsChanged, threadId);
    return report;
  });

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
  ipcMain.handle(CH.billingSelectPlan, (_e, planId: number, options?) =>
    selectPlan({ oauthIssuer: config.oauthIssuer }, () => auth.getAccessToken(), planId, options),
  );
  ipcMain.handle(CH.billingOverview, () =>
    fetchBillingOverview({ oauthIssuer: config.oauthIssuer }, () => auth.getAccessToken()),
  );
  ipcMain.handle(CH.billingPublishableKey, () =>
    fetchBillingPublishableKey({ oauthIssuer: config.oauthIssuer }, () => auth.getAccessToken()),
  );
  ipcMain.handle(CH.billingCompleteCrossCurrency, (_e, newSubscriptionId: string) =>
    completeCrossCurrencyUpgrade({ oauthIssuer: config.oauthIssuer }, () => auth.getAccessToken(), newSubscriptionId),
  );
  ipcMain.handle(CH.billingAbortCrossCurrency, (_e, newSubscriptionId: string) =>
    abortCrossCurrencyUpgrade({ oauthIssuer: config.oauthIssuer }, () => auth.getAccessToken(), newSubscriptionId),
  );

  /* Telemetry (renderer-side feature events). */
  ipcMain.on(CH.telemetryRecord, (_e, name: string, props?: Record<string, string | number | boolean>) => {
    telemetry.record(name, props);
    if (name === "settings-opened") reasonixMetrics.recordSettingsOpen();
  });

  ipcMain.handle(CH.reasonixMetricsGet, () => reasonixMetrics.get());
  ipcMain.handle(CH.reasonixMetricsReport, () => reasonixMetrics.generateWeeklyReport());
  ipcMain.handle(CH.reasonixDiagnosticsGet, (_e, threadId?: string) =>
    reasonixObservability.getDiagnostics(typeof threadId === "string" ? threadId : undefined),
  );
  ipcMain.handle(CH.reasonixCacheClear, (_e, threadId: string) => {
    if (typeof threadId === "string" && threadId.length > 0) {
      reasonixObservability.clearThreadCache(threadId);
    }
  });
  ipcMain.handle(
    CH.betaFeedbackSubmit,
    (_e, payload: { category: string; message: string; rating?: number }) => {
      const entry = {
        at: new Date().toISOString(),
        appVersion: app.getVersion(),
        category: payload.category ?? "general",
        message: String(payload.message ?? "").slice(0, 4000),
        rating: payload.rating ?? null,
      };
      appendFileSync(join(app.getPath("userData"), "beta-feedback.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
      telemetry.record("beta-feedback", { category: entry.category });
      return { ok: true };
    },
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

  /* Automations. */
  ipcMain.handle(CH.automationsList, () => automations.list());
  ipcMain.handle(CH.automationsCreate, (_e, input: Omit<import("../shared/types.js").Automation, "id" | "createdAt" | "updatedAt">) =>
    automations.create(input),
  );
  ipcMain.handle(CH.automationsUpdate, (_e, id: string, patch: Partial<Omit<import("../shared/types.js").Automation, "id" | "createdAt">>) =>
    automations.update(id, patch),
  );
  ipcMain.handle(CH.automationsDelete, (_e, id: string) => automations.remove(id));
  ipcMain.handle(CH.automationsToggle, (_e, id: string, enabled: boolean) => automations.toggle(id, enabled));
  ipcMain.handle(CH.automationsRun, (_e, id: string) => automations.run(id));
  ipcMain.on(CH.automationsStop, (_e, runId: string) => automations.stopRun(runId));
  ipcMain.handle(CH.automationsRuns, (_e, automationId?: string) => automations.listRuns(automationId));

  /* SSH hosts. */
  ipcMain.handle(CH.sshHostsList, () => automations.listSshHosts());
  ipcMain.handle(CH.sshHostsAdd, (_e, input: import("../shared/types.js").SshHostInput) => automations.addSshHost(input));
  ipcMain.handle(CH.sshHostsUpdate, (_e, id: string, patch: Partial<import("../shared/types.js").SshHostInput>) =>
    automations.updateSshHost(id, patch),
  );
  ipcMain.handle(CH.sshHostsRemove, (_e, id: string) => automations.removeSshHost(id));
  ipcMain.handle(CH.sshHostsSetCredentials, (_e, id: string, creds: import("../shared/types.js").SshHostCredentials) =>
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

  return {
    terminals,
    automations,
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
    dispose: () => {
      computerUse.unregisterShortcuts();
      agentHost.disposeAllShells();
      void chrome.dispose();
      telemetry.stop();
      void telemetry.flush();
      index.dispose();
      automations.dispose();
    },
  };
}
