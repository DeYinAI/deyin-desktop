import { contextBridge, ipcRenderer } from "electron";
import { CH, type DeyinApi } from "@deyin/contract";
import type {
  AgentEventEnvelope,
  AgentUiEvent,
  AutomationInfo,
  AutomationRun,
  BotPermissionSettings,
  EngineHostView,
  EngineSetupEvent,
  FileScope,
  TeachState,
  VaultSnapshot,
  BotsSnapshot,
  ChromeBridgeStatus,
  ComputerUseState,
  IndexStatus,
  TerminalDataEvent,
  TerminalExitEvent,
  UpdatesState,
} from "@deyin/contract";
import type { SuperagentView } from "@deyin/superagent/client";

const api: DeyinApi = {
  bootstrap: () => ipcRenderer.invoke(CH.bootstrap),
  auth: {
    connect: () => ipcRenderer.invoke(CH.authConnect),
    logout: () => ipcRenderer.invoke(CH.authLogout),
    getUser: () => ipcRenderer.invoke(CH.authGetUser),
    getAccessToken: () => ipcRenderer.invoke(CH.authGetToken),
    onChanged: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(CH.authChanged, listener);
      return () => ipcRenderer.removeListener(CH.authChanged, listener);
    },
  },
  models: {
    list: () => ipcRenderer.invoke(CH.modelsList),
    refresh: () => ipcRenderer.invoke(CH.modelsRefresh),
  },
  files: {
    tree: (dir) => ipcRenderer.invoke(CH.filesTree, dir),
    read: (path) => ipcRenderer.invoke(CH.filesRead, path),
    write: (path, content) => ipcRenderer.invoke(CH.filesWrite, path, content),
  },
  workspace: {
    openFolder: (startIn?: string) => ipcRenderer.invoke(CH.workspaceOpen, startIn),
    listDirectory: (path: string) => ipcRenderer.invoke(CH.workspaceListDirectory, path),
    setRoot: (root) => ipcRenderer.invoke(CH.workspaceSetRoot, root),
    connectRemote: (hostId: string, remotePath: string) =>
      ipcRenderer.invoke(CH.workspaceConnectRemote, hostId, remotePath),
    disconnectRemote: () => ipcRenderer.invoke(CH.workspaceDisconnectRemote),
    getLocation: () => ipcRenderer.invoke(CH.workspaceGetLocation),
    getRoot: () => ipcRenderer.invoke(CH.workspaceGetRoot),
    onRootChanged: (cb) => {
      let alive = true;
      const listener = (_e: unknown, root: string | null) => {
        if (alive) cb(root);
      };
      void ipcRenderer.invoke(CH.workspaceGetRoot).then((root: string | null) => {
        if (!alive) return;
        cb(root);
        ipcRenderer.on(CH.workspaceRootChanged, listener);
      });
      return () => {
        alive = false;
        ipcRenderer.removeListener(CH.workspaceRootChanged, listener);
      };
    },
    onLocationChanged: (cb) => {
      let alive = true;
      const listener = (_e: unknown, state: import("@deyin/contract").WorkspaceState) => {
        if (alive) cb(state);
      };
      void ipcRenderer.invoke(CH.workspaceGetLocation).then((state: import("@deyin/contract").WorkspaceState) => {
        if (!alive) return;
        cb(state);
        ipcRenderer.on(CH.workspaceLocationChanged, listener);
      });
      return () => {
        alive = false;
        ipcRenderer.removeListener(CH.workspaceLocationChanged, listener);
      };
    },
  },
  git: {
    info: () => ipcRenderer.invoke(CH.gitInfo),
    status: () => ipcRenderer.invoke(CH.gitStatus),
    branches: () => ipcRenderer.invoke(CH.gitBranches),
    checkout: (name) => ipcRenderer.invoke(CH.gitCheckout, name),
    stage: (paths) => ipcRenderer.invoke(CH.gitStage, paths),
    unstage: (paths) => ipcRenderer.invoke(CH.gitUnstage, paths),
    discard: (paths) => ipcRenderer.invoke(CH.gitDiscard, paths),
    commit: (message, opts) => ipcRenderer.invoke(CH.gitCommit, message, opts),
    fetch: () => ipcRenderer.invoke(CH.gitFetch),
    pull: (opts) => ipcRenderer.invoke(CH.gitPull, opts),
    push: (opts) => ipcRenderer.invoke(CH.gitPush, opts),
    createBranch: (name, from) => ipcRenderer.invoke(CH.gitCreateBranch, name, from),
    deleteBranch: (name, force) => ipcRenderer.invoke(CH.gitDeleteBranch, name, force),
    log: (opts) => ipcRenderer.invoke(CH.gitLog, opts),
    show: (ref) => ipcRenderer.invoke(CH.gitShow, ref),
    diffFile: (path, mode) => ipcRenderer.invoke(CH.gitDiffFile, path, mode),
    diffCommit: (ref, path) => ipcRenderer.invoke(CH.gitDiffCommit, ref, path),
    blame: (path) => ipcRenderer.invoke(CH.gitBlame, path),
    remotes: () => ipcRenderer.invoke(CH.gitRemotes),
    stashList: () => ipcRenderer.invoke(CH.gitStashList),
    stashPush: (message, includeUntracked) => ipcRenderer.invoke(CH.gitStashPush, message, includeUntracked),
    stashPop: (index) => ipcRenderer.invoke(CH.gitStashPop, index),
    stashDrop: (index) => ipcRenderer.invoke(CH.gitStashDrop, index),
    onChanged: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(CH.gitChanged, listener);
      return () => ipcRenderer.removeListener(CH.gitChanged, listener);
    },
  },
  projects: {
    get: () => ipcRenderer.invoke(CH.projectsGet),
    set: (patch) => ipcRenderer.invoke(CH.projectsSet, patch),
  },
  terminal: {
    create: (opts) => ipcRenderer.invoke(CH.termCreate, opts),
    attach: (id) => ipcRenderer.invoke(CH.termAttach, id),
    write: (id, data) => ipcRenderer.send(CH.termWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(CH.termResize, id, cols, rows),
    kill: (id) => ipcRenderer.send(CH.termKill, id),
    onData: (cb) => {
      const listener = (_e: unknown, payload: TerminalDataEvent) => cb(payload);
      ipcRenderer.on(CH.termData, listener);
      return () => ipcRenderer.removeListener(CH.termData, listener);
    },
    onExit: (cb) => {
      const listener = (_e: unknown, payload: TerminalExitEvent) => cb(payload);
      ipcRenderer.on(CH.termExit, listener);
      return () => ipcRenderer.removeListener(CH.termExit, listener);
    },
  },
  env: {
    detect: () => ipcRenderer.invoke(CH.envDetect),
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    set: (patch) => ipcRenderer.invoke(CH.settingsSet, patch),
  },
  caps: {
    list: (kind) => ipcRenderer.invoke(CH.capsList, kind),
    toggle: (id, enabled) => ipcRenderer.invoke(CH.capsToggle, id, enabled),
  },
  mcp: {
    list: () => ipcRenderer.invoke(CH.mcpList),
    add: (input) => ipcRenderer.invoke(CH.mcpAdd, input),
    remove: (name) => ipcRenderer.invoke(CH.mcpRemove, name),
    test: (name) => ipcRenderer.invoke(CH.mcpTest, name),
    catalog: {
      list: () => ipcRenderer.invoke(CH.mcpCatalogList),
      install: (input) => ipcRenderer.invoke(CH.mcpCatalogInstall, input),
    },
    modules: {
      list: () => ipcRenderer.invoke(CH.mcpModulesList),
      uninstall: (id) => ipcRenderer.invoke(CH.mcpModulesUninstall, id),
    },
    authenticate: (moduleId) => ipcRenderer.invoke(CH.mcpAuthenticate, moduleId),
    auth: {
      revoke: (moduleId) => ipcRenderer.invoke(CH.mcpAuthRevoke, moduleId),
      status: () => ipcRenderer.invoke(CH.mcpAuthStatus),
    },
  },
  plugins: {
    list: () => ipcRenderer.invoke(CH.pluginsList),
    catalog: (force) => ipcRenderer.invoke(CH.pluginsCatalog, force),
    install: (source) => ipcRenderer.invoke(CH.pluginsInstall, source),
    uninstall: (name) => ipcRenderer.invoke(CH.pluginsUninstall, name),
    setVariable: (plugin, name, value) => ipcRenderer.invoke(CH.pluginsSetVariable, plugin, name, value),
    variableState: (plugin, names) => ipcRenderer.invoke(CH.pluginsVariableState, plugin, names),
    kernelStatus: () => ipcRenderer.invoke(CH.pluginsKernelStatus),
  },
  index: {
    status: () => ipcRenderer.invoke(CH.indexStatus),
    rebuild: () => ipcRenderer.invoke(CH.indexRebuild),
    search: (query, topK) => ipcRenderer.invoke(CH.indexSearch, query, topK),
    onStatus: (cb) => {
      const listener = (_e: unknown, status: IndexStatus) => cb(status);
      ipcRenderer.on(CH.indexStatusEvent, listener);
      return () => ipcRenderer.removeListener(CH.indexStatusEvent, listener);
    },
  },
agent: {
 start: (options) => ipcRenderer.invoke(CH.agentStart, options),
 stop: (threadId) => ipcRenderer.send(CH.agentStop, threadId),
 resetSession: (threadId) => ipcRenderer.invoke(CH.agentResetSession, threadId),
 approve: (requestId, decision) => ipcRenderer.send(CH.agentApprove, requestId, decision),
 answerQuestion: (requestId, answers) => ipcRenderer.send(CH.agentAnswerQuestion, requestId, answers),
 answerSecureForm: (requestId, values) => ipcRenderer.send(CH.agentAnswerSecureForm, requestId, values),
 disposeShell: (threadId) => ipcRenderer.send(CH.agentDisposeShell, threadId),
 onEvent: (cb) => {
 const listener = (_e: unknown, envelope: AgentEventEnvelope) => cb(envelope);
 ipcRenderer.on(CH.agentEvent, listener);
 return () => ipcRenderer.removeListener(CH.agentEvent, listener);
 },
 },
  checkpoints: {
    revertRun: (threadId, checkpointId) =>
      ipcRenderer.invoke(CH.checkpointsRevertRun, threadId, checkpointId),
    revertFile: (threadId, checkpointId, path) =>
      ipcRenderer.invoke(CH.checkpointsRevertFile, threadId, checkpointId, path),
    revertAfterEvent: (threadId, eventIndex, events) =>
      ipcRenderer.invoke(CH.checkpointsRevertAfterEvent, threadId, eventIndex, events),
  },
  browserControl: {
    register: (webContentsId) => ipcRenderer.send(CH.browserRegister, webContentsId),
    syncTab: (webContentsId, url, title) => ipcRenderer.send(CH.browserTabSync, webContentsId, url, title),
    removeTab: (webContentsId) => ipcRenderer.send(CH.browserTabRemove, webContentsId),
    getPartition: () => ipcRenderer.invoke(CH.browserGetPartition),
    clearProfile: () => ipcRenderer.invoke(CH.browserClearProfile),
    onEnsure: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(CH.browserEnsure, listener);
      return () => ipcRenderer.removeListener(CH.browserEnsure, listener);
    },
    onTabCommand: (cb) => {
      const listener = (_e: unknown, cmd: import("@deyin/contract").BrowserTabCommand) => cb(cmd);
      ipcRenderer.on(CH.browserTabCommand, listener);
      return () => ipcRenderer.removeListener(CH.browserTabCommand, listener);
    },
    onActive: (cb) => {
      const listener = (_e: unknown, active: boolean) => cb(active);
      ipcRenderer.on(CH.browserActive, listener);
      return () => ipcRenderer.removeListener(CH.browserActive, listener);
    },
  },
  computerUse: {
    getAllowlist: () => ipcRenderer.invoke(CH.computerUseGetAllowlist),
    setAllowlist: (apps) => ipcRenderer.invoke(CH.computerUseSetAllowlist, apps),
    listApps: () => ipcRenderer.invoke(CH.computerUseListApps),
    getHostStatus: () => ipcRenderer.invoke(CH.computerUseGetHostStatus),
    onState: (cb) => {
      const listener = (_e: unknown, state: ComputerUseState) => cb(state);
      ipcRenderer.on(CH.computerUseState, listener);
      return () => ipcRenderer.removeListener(CH.computerUseState, listener);
    },
    stop: () => ipcRenderer.send(CH.computerUseStop),
    resume: () => ipcRenderer.send(CH.computerUseResume),
    onAppApprovalRequest: (cb) => {
      const listener = (_e: unknown, req: { requestId: string; appId: string; action: string }) => cb(req);
      ipcRenderer.on(CH.computerUseAppApprovalRequest, listener);
      return () => ipcRenderer.removeListener(CH.computerUseAppApprovalRequest, listener);
    },
    respondAppApproval: (requestId, decision) =>
      ipcRenderer.send(CH.computerUseAppApprovalRespond, requestId, decision),
  },
  chrome: {
    getStatus: () => ipcRenderer.invoke(CH.chromeGetStatus),
    onStatus: (cb) => {
      const listener = (_e: unknown, status: ChromeBridgeStatus) => cb(status);
      ipcRenderer.on(CH.chromeStatus, listener);
      return () => ipcRenderer.removeListener(CH.chromeStatus, listener);
    },
    beginPairing: () => ipcRenderer.invoke(CH.chromeBeginPairing),
    cancelPairing: () => ipcRenderer.invoke(CH.chromeCancelPairing),
    forgetBrowser: (browserId) => ipcRenderer.invoke(CH.chromeForgetBrowser, browserId),
    stop: () => ipcRenderer.invoke(CH.chromeStop),
    resume: () => ipcRenderer.invoke(CH.chromeResume),
    closeAgentTabs: () => ipcRenderer.invoke(CH.chromeCloseAgentTabs),
    getApprovedOrigins: () => ipcRenderer.invoke(CH.chromeGetApprovedOrigins),
    setApprovedOrigins: (origins) => ipcRenderer.invoke(CH.chromeSetApprovedOrigins, origins),
    openExtensionFolder: () => ipcRenderer.invoke(CH.chromeOpenExtensionFolder),
    onActive: (cb) => {
      const listener = (_e: unknown, active: boolean) => cb(active);
      ipcRenderer.on(CH.chromeActive, listener);
      return () => ipcRenderer.removeListener(CH.chromeActive, listener);
    },
    onOriginApprovalRequest: (cb) => {
      const listener = (_e: unknown, req: { requestId: string; origin: string; action: string }) => cb(req);
      ipcRenderer.on(CH.chromeOriginApprovalRequest, listener);
      return () => ipcRenderer.removeListener(CH.chromeOriginApprovalRequest, listener);
    },
    respondOriginApproval: (requestId, decision) =>
      ipcRenderer.send(CH.chromeOriginApprovalRespond, requestId, decision),
  },
  workspaceTrust: {
    onRequest: (cb) => {
      const listener = (_e: unknown, req: { requestId: string; root: string }) => cb(req);
      ipcRenderer.on(CH.workspaceTrustRequest, listener);
      return () => ipcRenderer.removeListener(CH.workspaceTrustRequest, listener);
    },
    respond: (requestId, decision) =>
      ipcRenderer.send(CH.workspaceTrustRespond, requestId, decision),
  },
  visualize: {
    read: (threadId, fileName) => ipcRenderer.invoke(CH.visualizeRead, threadId, fileName),
  },
  page: {
    read: (threadId, fileName) => ipcRenderer.invoke(CH.pageRead, threadId, fileName),
  },
  images: {
    save: (threadId, input) => ipcRenderer.invoke(CH.imagesSave, threadId, input),
    read: (threadId, fileName) => ipcRenderer.invoke(CH.imagesRead, threadId, fileName),
    generate: (request) => ipcRenderer.invoke(CH.imagesGenerate, request),
  },
  videos: {
    save: (threadId, input) => ipcRenderer.invoke(CH.videosSave, threadId, input),
    read: (threadId, fileName) => ipcRenderer.invoke(CH.videosRead, threadId, fileName),
    generate: (request) => ipcRenderer.invoke(CH.videosGenerate, request),
  },
  vision: {
    describeLocal: (images, userText) => ipcRenderer.invoke(CH.visionDescribeLocal, images, userText),
    localStatus: () => ipcRenderer.invoke(CH.visionLocalStatus),
  },
  telemetry: {
    record: (name, props) => ipcRenderer.send(CH.telemetryRecord, name, props),
  },
  providers: {
    list: () => ipcRenderer.invoke(CH.providersList),
    add: (input) => ipcRenderer.invoke(CH.providersAdd, input),
    update: (id, patch) => ipcRenderer.invoke(CH.providersUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(CH.providersRemove, id),
    setKey: (id, key) => ipcRenderer.invoke(CH.providersSetKey, id, key),
    getKey: (id) => ipcRenderer.invoke(CH.providersGetKey, id),
    test: (id) => ipcRenderer.invoke(CH.providersTest, id),
    fetchModels: (id) => ipcRenderer.invoke(CH.providersFetchModels, id),
  },
  usage: {
    get: () => ipcRenderer.invoke(CH.usageGet),
    record: (event) => ipcRenderer.invoke(CH.usageRecord, event),
    account: (force) => ipcRenderer.invoke(CH.usageAccount, force),
  },
  plans: {
    list: () => ipcRenderer.invoke(CH.plansList),
    releaseStatus: () => ipcRenderer.invoke(CH.plansReleaseStatus),
  },
  billing: {
    overview: () => ipcRenderer.invoke(CH.billingOverview),
    selectPlan: (planId, options) => ipcRenderer.invoke(CH.billingSelectPlan, planId, options),
    publishableKey: () => ipcRenderer.invoke(CH.billingPublishableKey),
    completeCrossCurrencyUpgrade: (newSubscriptionId) =>
      ipcRenderer.invoke(CH.billingCompleteCrossCurrency, newSubscriptionId),
    abortCrossCurrencyUpgrade: (newSubscriptionId) =>
      ipcRenderer.invoke(CH.billingAbortCrossCurrency, newSubscriptionId),
  },
  win: {
    minimize: () => ipcRenderer.send(CH.winMinimize),
    toggleMaximize: () => ipcRenderer.send(CH.winToggleMaximize),
    close: () => ipcRenderer.send(CH.winClose),
  },
  browserData: {
    clearCache: () => ipcRenderer.invoke(CH.browserClearCache),
    clearAll: () => ipcRenderer.invoke(CH.browserClearAll),
  },
  search: {
    query: (q) => ipcRenderer.invoke(CH.searchQuery, q),
  },
  shell: {
    showItem: (path) => ipcRenderer.send(CH.shellShowItem, path),
    openExternal: (url) => ipcRenderer.send(CH.shellOpenExternal, url),
  },
  clipboard: {
    readText: () => ipcRenderer.invoke(CH.clipboardReadText),
    writeText: (text) => ipcRenderer.invoke(CH.clipboardWriteText, text),
  },
  contextMenu: {
    show: (request) => ipcRenderer.invoke(CH.contextMenu, request),
  },
  paths: {
    get: () => ipcRenderer.invoke(CH.pathsGet),
  },
  identity: {
    get: () => ipcRenderer.invoke(CH.identityGet),
    sync: () => ipcRenderer.invoke(CH.identitySync),
  },
  diagnostics: {
    send: (note) => ipcRenderer.invoke(CH.diagnosticsSend, note),
  },
  logs: {
    write: (level, message) => ipcRenderer.send(CH.logWrite, level, message),
  },
  updates: {
    getState: () => ipcRenderer.invoke(CH.updatesGetState),
    check: (opts?: { userInitiated?: boolean }) => ipcRenderer.invoke(CH.updatesCheck, opts),
    download: () => ipcRenderer.invoke(CH.updatesDownload),
    install: () => ipcRenderer.send(CH.updatesInstall),
    onState: (cb) => {
      const listener = (_e: unknown, state: UpdatesState) => cb(state);
      ipcRenderer.on(CH.updatesState, listener);
      return () => ipcRenderer.removeListener(CH.updatesState, listener);
    },
  },
  context: {
    search: (query) => ipcRenderer.invoke(CH.contextSearch, query),
    resolve: (refs) => ipcRenderer.invoke(CH.contextResolve, refs),
  },
  review: {
    list: (threadId) => ipcRenderer.invoke(CH.reviewList, threadId),
    approve: (threadId, changeId) => ipcRenderer.invoke(CH.reviewApprove, threadId, changeId),
    reject: (threadId, changeId) => ipcRenderer.invoke(CH.reviewReject, threadId, changeId),
    approveAll: (threadId) => ipcRenderer.invoke(CH.reviewApproveAll, threadId),
    rejectAll: (threadId) => ipcRenderer.invoke(CH.reviewRejectAll, threadId),
  },
  security: {
    listFindings: (threadId) => ipcRenderer.invoke(CH.securityListFindings, threadId),
    clearFindings: (threadId) => ipcRenderer.invoke(CH.securityClearFindings, threadId),
    scanDiff: (threadId, diff) => ipcRenderer.invoke(CH.securityScanDiff, threadId, diff),
    onFindingsChanged: (cb) => {
      const listener = (_e: unknown, threadId: string) => cb(threadId);
      ipcRenderer.on(CH.securityFindingsChanged, listener);
      return () => ipcRenderer.removeListener(CH.securityFindingsChanged, listener);
    },
  },
  beta: {
    submitFeedback: (payload) => ipcRenderer.invoke(CH.betaFeedbackSubmit, payload),
  },
  automations: {
    list: () => ipcRenderer.invoke(CH.automationsList),
    create: (input) => ipcRenderer.invoke(CH.automationsCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CH.automationsUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(CH.automationsDelete, id),
    toggle: (id, enabled) => ipcRenderer.invoke(CH.automationsToggle, id, enabled),
    revertLearned: (id, revisionId) => ipcRenderer.invoke(CH.automationsRevertLearned, id, revisionId),
    run: (id) => ipcRenderer.invoke(CH.automationsRun, id),
    stop: (runId) => ipcRenderer.send(CH.automationsStop, runId),
    runs: (automationId) => ipcRenderer.invoke(CH.automationsRuns, automationId),
    testWsl: (distro) => ipcRenderer.invoke(CH.wslTestDistro, distro),
    onEvent: (cb) => {
      const listener = (_e: unknown, payload: { runId: string; automationId: string; event: AgentUiEvent }) => cb(payload);
      ipcRenderer.on(CH.automationEvent, listener);
      return () => ipcRenderer.removeListener(CH.automationEvent, listener);
    },
    onRunFinished: (cb) => {
      const listener = (_e: unknown, payload: { run: AutomationRun }) => cb(payload);
      ipcRenderer.on(CH.automationRunFinished, listener);
      return () => ipcRenderer.removeListener(CH.automationRunFinished, listener);
    },
    onChange: (cb) => {
      const listener = (_e: unknown, payload: AutomationInfo[]) => cb(payload);
      ipcRenderer.on(CH.automationsChanged, listener);
      return () => ipcRenderer.removeListener(CH.automationsChanged, listener);
    },
  },
  superagent: {
    view: () => ipcRenderer.invoke(CH.superagentView),
    saveSettings: (settings, baseRevision) => ipcRenderer.invoke(CH.superagentSaveSettings, settings, baseRevision),
    setToken: (token) => ipcRenderer.invoke(CH.superagentSetToken, token),
    clearToken: () => ipcRenderer.invoke(CH.superagentClearToken),
    verify: () => ipcRenderer.invoke(CH.superagentVerify),
    stopTicket: (ticketId) => ipcRenderer.invoke(CH.superagentStopTicket, ticketId),
    retryTicket: (ticketId) => ipcRenderer.invoke(CH.superagentRetryTicket, ticketId),
    requeue: (triggerId) => ipcRenderer.invoke(CH.superagentRequeue, triggerId),
    reset: () => ipcRenderer.invoke(CH.superagentReset),
    onChanged: (cb) => {
      const listener = (_e: unknown, view: SuperagentView) => cb(view);
      ipcRenderer.on(CH.superagentChanged, listener);
      return () => ipcRenderer.removeListener(CH.superagentChanged, listener);
    },
  },
  sshHosts: {
    list: () => ipcRenderer.invoke(CH.sshHostsList),
    add: (input) => ipcRenderer.invoke(CH.sshHostsAdd, input),
    update: (id, patch) => ipcRenderer.invoke(CH.sshHostsUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(CH.sshHostsRemove, id),
    setCredentials: (id, creds) => ipcRenderer.invoke(CH.sshHostsSetCredentials, id, creds),
    test: (hostId, acceptFingerprint) => ipcRenderer.invoke(CH.sshHostsTest, hostId, acceptFingerprint),
    pinFingerprint: (hostId, fingerprint) => ipcRenderer.invoke(CH.sshHostsPinFingerprint, hostId, fingerprint),
    importKey: () => ipcRenderer.invoke(CH.sshHostsImportKey),
    browse: (hostId: string, remotePath: string) => ipcRenderer.invoke(CH.sshBrowse, hostId, remotePath),
  },
  repo: {
    connect: (opts) => ipcRenderer.invoke(CH.repoConnect, opts),
    state: () => ipcRenderer.invoke(CH.repoState),
    ship: () => Promise.reject(new Error("Ship is web-only")),
    onProgress: (cb) => {
      const listener = (_e: unknown, payload: import("@deyin/contract").RepoProgressEvent) => cb(payload);
      ipcRenderer.on(CH.repoProgress, listener);
      return () => ipcRenderer.removeListener(CH.repoProgress, listener);
    },
  },
  github: {
    connect: () => ipcRenderer.invoke(CH.githubConnect),
    disconnect: () => ipcRenderer.invoke(CH.githubDisconnect),
    authState: () => ipcRenderer.invoke(CH.githubAuthState),
    listRepos: (query?: string) => ipcRenderer.invoke(CH.githubListRepos, query),
  },
  externalAgents: {
    list: (forceRefresh) => ipcRenderer.invoke(CH.externalAgentsList, forceRefresh),
    test: (agentId) => ipcRenderer.invoke(CH.externalAgentsTest, agentId),
    run: (options) => ipcRenderer.invoke(CH.externalAgentsRun, options),
    abort: (runId) => ipcRenderer.invoke(CH.externalAgentsAbort, runId),
    nudge: (runId, message) => ipcRenderer.invoke(CH.externalAgentsNudge, runId, message),
    logs: (runId, maxLines) => ipcRenderer.invoke(CH.externalAgentsLogs, runId, maxLines),
  },
  conductorWorkflows: {
    list: () => ipcRenderer.invoke(CH.conductorWorkflowsList),
    save: (workflow) => ipcRenderer.invoke(CH.conductorWorkflowsSave, workflow),
    delete: (id) => ipcRenderer.invoke(CH.conductorWorkflowsDelete, id),
    run: (workflowId, cwd) => ipcRenderer.invoke(CH.conductorWorkflowsRun, workflowId, cwd),
    abort: (runId) => ipcRenderer.invoke(CH.conductorWorkflowsAbort, runId),
    merge: (workspaceRoot, branchName) => ipcRenderer.invoke(CH.conductorWorkflowsMerge, workspaceRoot, branchName),
    onEvent: (cb) => {
      const listener = (_e: unknown, payload: any) => cb(payload);
      ipcRenderer.on(CH.conductorWorkflowsEvent, listener);
      return () => ipcRenderer.removeListener(CH.conductorWorkflowsEvent, listener);
    },
  },
  bots: {
    list: () => ipcRenderer.invoke(CH.botsList),
    create: (input) => ipcRenderer.invoke(CH.botsCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CH.botsUpdate, id, patch),
    archive: (id) => ipcRenderer.invoke(CH.botsArchive, id),
    restore: (id) => ipcRenderer.invoke(CH.botsRestore, id),
    delete: (id) => ipcRenderer.invoke(CH.botsDelete, id),
    setPrimary: (id) => ipcRenderer.invoke(CH.botsSetPrimary, id),
    setPinned: (id, pinned) => ipcRenderer.invoke(CH.botsSetPinned, id, pinned),
    setHidden: (id, hidden) => ipcRenderer.invoke(CH.botsSetHidden, id, hidden),
    addSection: (name) => ipcRenderer.invoke(CH.botsAddSection, name),
    renameSection: (sectionId, name) => ipcRenderer.invoke(CH.botsRenameSection, sectionId, name),
    removeSection: (sectionId) => ipcRenderer.invoke(CH.botsRemoveSection, sectionId),
    moveToSection: (id, sectionId) => ipcRenderer.invoke(CH.botsMoveToSection, id, sectionId),
    memoryList: (id) => ipcRenderer.invoke(CH.botsMemoryList, id),
    memoryForget: (id, ref) => ipcRenderer.invoke(CH.botsMemoryForget, id, ref),
    memoryShare: (id, ref, shared) => ipcRenderer.invoke(CH.botsMemoryShare, id, ref, shared),
    onChange: (cb) => {
      const listener = (_e: unknown, payload: BotsSnapshot) => cb(payload);
      ipcRenderer.on(CH.botsChanged, listener);
      return () => ipcRenderer.removeListener(CH.botsChanged, listener);
    },
  },
  botAvatar: {
    generate: (request) => ipcRenderer.invoke(CH.botAvatarGenerate, request),
  },
  botPermissions: {
    get: () => ipcRenderer.invoke(CH.botPermissionsGet),
    update: (patch) => ipcRenderer.invoke(CH.botPermissionsUpdate, patch),
    onChange: (cb) => {
      const listener = (_e: unknown, payload: BotPermissionSettings) => cb(payload);
      ipcRenderer.on(CH.botPermissionsChanged, listener);
      return () => ipcRenderer.removeListener(CH.botPermissionsChanged, listener);
    },
  },
  botSkills: {
    list: (botId) => ipcRenderer.invoke(CH.botSkillsList, botId),
    get: (botId, name) => ipcRenderer.invoke(CH.botSkillsGet, botId, name),
    save: (botId, input, expectedVersion) => ipcRenderer.invoke(CH.botSkillsSave, botId, input, expectedVersion),
    remove: (botId, name) => ipcRenderer.invoke(CH.botSkillsRemove, botId, name),
    revisions: (botId, name) => ipcRenderer.invoke(CH.botSkillsRevisions, botId, name),
    revert: (botId, name, revisionId) => ipcRenderer.invoke(CH.botSkillsRevert, botId, name, revisionId),
    onChange: (cb) => {
      const listener = (_e: unknown, botId: string) => cb(botId);
      ipcRenderer.on(CH.botSkillsChanged, listener);
      return () => ipcRenderer.removeListener(CH.botSkillsChanged, listener);
    },
  },
  botTemplates: {
    export: (botId, options) => ipcRenderer.invoke(CH.botTemplatesExport, botId, options),
    preview: (text) => ipcRenderer.invoke(CH.botTemplatesPreview, text),
    import: (text, options) => ipcRenderer.invoke(CH.botTemplatesImport, text, options),
    catalog: (query, category) => ipcRenderer.invoke(CH.botTemplatesCatalog, query, category),
    importCatalog: (id, options) => ipcRenderer.invoke(CH.botTemplatesImportCatalog, id, options),
    takeLink: () => ipcRenderer.invoke(CH.botTemplatesTakeLink),
    onLink: (cb) => {
      const listener = (_e: unknown, link: string) => cb(link);
      ipcRenderer.on(CH.botTemplatesLink, listener);
      return () => ipcRenderer.removeListener(CH.botTemplatesLink, listener);
    },
  },
  botFiles: {
    list: (scope, botId, path) => ipcRenderer.invoke(CH.botFilesList, scope, botId, path),
    read: (scope, botId, path) => ipcRenderer.invoke(CH.botFilesRead, scope, botId, path),
    write: (scope, botId, path, content) => ipcRenderer.invoke(CH.botFilesWrite, scope, botId, path, content),
    remove: (scope, botId, path) => ipcRenderer.invoke(CH.botFilesRemove, scope, botId, path),
    copy: (direction, botId, path, as) => ipcRenderer.invoke(CH.botFilesCopy, direction, botId, path, as),
    onChange: (cb) => {
      const listener = (_e: unknown, event: { scope: FileScope; botId: string | null }) => cb(event);
      ipcRenderer.on(CH.botFilesChanged, listener);
      return () => ipcRenderer.removeListener(CH.botFilesChanged, listener);
    },
  },
  botTeach: {
    state: () => ipcRenderer.invoke(CH.botTeachState),
    start: (botId, title) => ipcRenderer.invoke(CH.botTeachStart, botId, title),
    note: (text) => ipcRenderer.invoke(CH.botTeachNote, text),
    stop: (options) => ipcRenderer.invoke(CH.botTeachStop, options),
    cancel: () => ipcRenderer.invoke(CH.botTeachCancel),
    save: (botId, skill) => ipcRenderer.invoke(CH.botTeachSave, botId, skill),
    onChange: (cb) => {
      const listener = (_e: unknown, state: TeachState) => cb(state);
      ipcRenderer.on(CH.botTeachChanged, listener);
      return () => ipcRenderer.removeListener(CH.botTeachChanged, listener);
    },
  },
  botSurfaces: {
    state: (botId) => ipcRenderer.invoke(CH.botSurfacesState, botId),
    save: (botId, kind, input) => ipcRenderer.invoke(CH.botSurfacesSave, botId, kind, input),
    remake: (botId, kind, name) => ipcRenderer.invoke(CH.botSurfacesRemake, botId, kind, name),
    setEnabled: (botId, kind, enabled) => ipcRenderer.invoke(CH.botSurfacesSetEnabled, botId, kind, enabled),
    remove: (botId, kind) => ipcRenderer.invoke(CH.botSurfacesRemove, botId, kind),
    setHub: (settings) => ipcRenderer.invoke(CH.botSurfacesSetHub, settings),
    outboxEdit: (id, text) => ipcRenderer.invoke(CH.botSurfacesOutboxEdit, id, text),
    outboxApprove: (id) => ipcRenderer.invoke(CH.botSurfacesOutboxApprove, id),
    outboxDeny: (id) => ipcRenderer.invoke(CH.botSurfacesOutboxDeny, id),
    onChange: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(CH.botSurfacesChanged, listener);
      return () => ipcRenderer.removeListener(CH.botSurfacesChanged, listener);
    },
  },
  vault: {
    get: () => ipcRenderer.invoke(CH.vaultGet),
    save: (input) => ipcRenderer.invoke(CH.vaultSave, input),
    remove: (id) => ipcRenderer.invoke(CH.vaultRemove, id),
    revoke: (botId, itemId, host) => ipcRenderer.invoke(CH.vaultRevoke, botId, itemId, host),
    onChange: (cb) => {
      const listener = (_e: unknown, payload: VaultSnapshot) => cb(payload);
      ipcRenderer.on(CH.vaultChanged, listener);
      return () => ipcRenderer.removeListener(CH.vaultChanged, listener);
    },
  },
  engines: {
    list: () => ipcRenderer.invoke(CH.enginesList),
    status: (hostId) => ipcRenderer.invoke(CH.enginesStatus, hostId),
    install: (hostId) => ipcRenderer.invoke(CH.enginesInstall, hostId),
    cancel: (hostId) => ipcRenderer.invoke(CH.enginesCancel, hostId),
    uninstall: (hostId, purge) => ipcRenderer.invoke(CH.enginesUninstall, hostId, purge),
    forget: (hostId) => ipcRenderer.invoke(CH.enginesForget, hostId),
    health: (botId) => ipcRenderer.invoke(CH.enginesHealth, botId),
    onChange: (cb) => {
      const listener = (_e: unknown, payload: EngineHostView[]) => cb(payload);
      ipcRenderer.on(CH.enginesChanged, listener);
      return () => ipcRenderer.removeListener(CH.enginesChanged, listener);
    },
    onSetup: (cb) => {
      const listener = (_e: unknown, payload: EngineSetupEvent) => cb(payload);
      ipcRenderer.on(CH.enginesSetup, listener);
      return () => ipcRenderer.removeListener(CH.enginesSetup, listener);
    },
  },
};

contextBridge.exposeInMainWorld("deyin", api);
