import { contextBridge, ipcRenderer } from "electron";
import { CH, type DeyinApi } from "../shared/ipc.js";
import type { TerminalDataEvent, TerminalExitEvent } from "../shared/types.js";

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
  },
  files: {
    tree: (dir) => ipcRenderer.invoke(CH.filesTree, dir),
    read: (path) => ipcRenderer.invoke(CH.filesRead, path),
  },
  workspace: {
    openFolder: () => ipcRenderer.invoke(CH.workspaceOpen),
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
  providers: {
    list: () => ipcRenderer.invoke(CH.providersList),
    add: (input) => ipcRenderer.invoke(CH.providersAdd, input),
    update: (id, patch) => ipcRenderer.invoke(CH.providersUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(CH.providersRemove, id),
    setKey: (id, key) => ipcRenderer.invoke(CH.providersSetKey, id, key),
    getKey: (id) => ipcRenderer.invoke(CH.providersGetKey, id),
    test: (id) => ipcRenderer.invoke(CH.providersTest, id),
  },
  usage: {
    get: () => ipcRenderer.invoke(CH.usageGet),
    record: (event) => ipcRenderer.invoke(CH.usageRecord, event),
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
};

contextBridge.exposeInMainWorld("deyin", api);
