import { contextBridge, ipcRenderer } from "electron";
import { CH, type DeyinApi } from "../shared/ipc.js";
import type { AgentEventEnvelope, IndexStatus, TerminalDataEvent, TerminalExitEvent, UpdatesState } from "../shared/types.js";

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
  },
  workspace: {
    openFolder: () => ipcRenderer.invoke(CH.workspaceOpen),
    setRoot: (root) => ipcRenderer.invoke(CH.workspaceSetRoot, root),
  },
  projects: {
    get: () => ipcRenderer.invoke(CH.projectsGet),
    set: (patch) => ipcRenderer.invoke(CH.projectsSet, patch),
  },
  terminal: {
    create: (opts) => ipcRenderer.invoke(CH.termCreate, opts),
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
  },
  plugins: {
    list: () => ipcRenderer.invoke(CH.pluginsList),
    catalog: (force) => ipcRenderer.invoke(CH.pluginsCatalog, force),
    install: (source) => ipcRenderer.invoke(CH.pluginsInstall, source),
    uninstall: (name) => ipcRenderer.invoke(CH.pluginsUninstall, name),
    setVariable: (plugin, name, value) => ipcRenderer.invoke(CH.pluginsSetVariable, plugin, name, value),
    variableState: (plugin, names) => ipcRenderer.invoke(CH.pluginsVariableState, plugin, names),
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
    onEvent: (cb) => {
      const listener = (_e: unknown, envelope: AgentEventEnvelope) => cb(envelope);
      ipcRenderer.on(CH.agentEvent, listener);
      return () => ipcRenderer.removeListener(CH.agentEvent, listener);
    },
  },
  browserControl: {
    register: (webContentsId) => ipcRenderer.send(CH.browserRegister, webContentsId),
    getPartition: () => ipcRenderer.invoke(CH.browserGetPartition),
    clearProfile: () => ipcRenderer.invoke(CH.browserClearProfile),
    onEnsure: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(CH.browserEnsure, listener);
      return () => ipcRenderer.removeListener(CH.browserEnsure, listener);
    },
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
    check: () => ipcRenderer.invoke(CH.updatesCheck),
    download: () => ipcRenderer.invoke(CH.updatesDownload),
    install: () => ipcRenderer.send(CH.updatesInstall),
    onState: (cb) => {
      const listener = (_e: unknown, state: UpdatesState) => cb(state);
      ipcRenderer.on(CH.updatesState, listener);
      return () => ipcRenderer.removeListener(CH.updatesState, listener);
    },
  },
};

contextBridge.exposeInMainWorld("deyin", api);
