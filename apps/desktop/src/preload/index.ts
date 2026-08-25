import { contextBridge, ipcRenderer } from "electron";
import { CH, type DeyinApi } from "@deyin/contract";
import type {
  AgentEventEnvelope,
  AgentUiEvent,
  AutomationRun,
  IndexStatus,
  TerminalDataEvent,
  TerminalExitEvent,
  UpdatesState,
} from "@deyin/contract";

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
      const listener = (_e: unknown, state: import("@deyin/contract").WorkspaceState) => cb(state);
      void ipcRenderer.invoke(CH.workspaceGetLocation).then((state: import("@deyin/contract").WorkspaceState) => {
        cb(state);
        ipcRenderer.on(CH.workspaceLocationChanged, listener);
      });
      return () => ipcRenderer.removeListener(CH.workspaceLocationChanged, listener);
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
 approve: (requestId, decision) => ipcRenderer.send(CH.agentApprove, requestId, decision),
 answerQuestion: (requestId, answers) => ipcRenderer.send(CH.agentAnswerQuestion, requestId, answers),
 disposeShell: (threadId) => ipcRenderer.send(CH.agentDisposeShell, threadId),
 onEvent: (cb) => {
 const listener = (_e: unknown, envelope: AgentEventEnvelope) => cb(envelope);
 ipcRenderer.on(CH.agentEvent, listener);
 return () => ipcRenderer.removeListener(CH.agentEvent, listener);
 },
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
    onActive: (cb) => {
      const listener = (_e: unknown, active: boolean) => cb(active);
      ipcRenderer.on(CH.computerUseActive, listener);
      return () => ipcRenderer.removeListener(CH.computerUseActive, listener);
    },
    onAppApprovalRequest: (cb) => {
      const listener = (_e: unknown, req: { requestId: string; appId: string; action: string }) => cb(req);
      ipcRenderer.on(CH.computerUseAppApprovalRequest, listener);
      return () => ipcRenderer.removeListener(CH.computerUseAppApprovalRequest, listener);
    },
    respondAppApproval: (requestId, decision) =>
      ipcRenderer.send(CH.computerUseAppApprovalRespond, requestId, decision),
  },
  visualize: {
    read: (threadId, fileName) => ipcRenderer.invoke(CH.visualizeRead, threadId, fileName),
  },
  images: {
    save: (threadId, input) => ipcRenderer.invoke(CH.imagesSave, threadId, input),
    read: (threadId, fileName) => ipcRenderer.invoke(CH.imagesRead, threadId, fileName),
    generate: (request) => ipcRenderer.invoke(CH.imagesGenerate, request),
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
};

contextBridge.exposeInMainWorld("deyin", api);
