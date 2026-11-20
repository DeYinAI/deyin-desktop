// Deyin Browser Bridge: MV3 service worker.
//
// A thin chrome.debugger relay. It connects OUT to the Deyin desktop app on a
// loopback WebSocket; all automation logic lives in Deyin. This file enforces
// the rules that must hold even if the desktop side misbehaves:
//   - nothing is exposed until the user pairs (code shown on both sides + Allow)
//   - only tabs Deyin opened (the "Deyin" group) or the user shared are visible
//   - the debugger is attached lazily, per tab, and only for those tabs
//   - no incognito, no chrome:// / extension / devtools pages
//   - an explicit allowlist of CDP methods (no cookies, no Target/Browser/Fetch)
//   - Stop detaches everything and blocks the host until resumed
//
// Wire format: see host/chrome-protocol.ts (types mirrored by hand here).

const PROTOCOL_VERSION = 1;
const PORTS = [9410, 9411, 9412, 9413, 9414];
const GROUP_TITLE = "Deyin";
const DEFAULT_CDP_TIMEOUT_MS = 30000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const SEARCH_BACKOFF_MS = 8000;

const BLOCKED_SCHEMES = new Set([
  "chrome:",
  "chrome-extension:",
  "chrome-untrusted:",
  "chrome-search:",
  "edge:",
  "devtools:",
  "view-source:",
  "javascript:",
]);

/** The only CDP methods the host may call. Everything else is refused here. */
const CDP_ALLOWED = new Set([
  "Page.enable",
  "Page.navigate",
  "Page.reload",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Page.getFrameTree",
  "Page.handleJavaScriptDialog",
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.getContentQuads",
  "DOM.focus",
  "DOM.resolveNode",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.describeNode",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Input.setInterceptDrags",
  "Input.dispatchDragEvent",
  "Accessibility.getFullAXTree",
  "Log.enable",
  "Network.enable",
  "Emulation.setFocusEmulationEnabled",
]);

/** CDP events forwarded to the host (others are dropped at the source). */
const EVENTS_FORWARDED = new Set([
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Log.entryAdded",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFailed",
  "Page.javascriptDialogOpening",
  "Page.javascriptDialogClosed",
  "Page.frameNavigated",
  "Input.dragIntercepted",
]);

/* State --------------------------------------------------------------------- */

/** Persisted in chrome.storage.local (survives browser restarts). */
let local = { browserId: "", pairToken: "", enabled: true };
/** Persisted in chrome.storage.session (survives service-worker restarts). */
let session = { agentTabs: [], sharedTabs: [], attachedTabs: [], groups: {}, agentWindowId: null, userActive: {}, stopped: false, stoppedBy: null };

/** Connection to Deyin. link: off | searching | pairing_wait | pairing_confirm | connected */
let ws = null;
let link = "off";
let pendingPair = null; // { commit, extNonce, code, hostNonce }
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let portIndex = 0;
let portsTriedThisRound = 0;

const ready = (async () => {
  const stored = await chrome.storage.local.get(["browserId", "pairToken", "enabled"]);
  local = {
    browserId: stored.browserId || crypto.randomUUID(),
    pairToken: stored.pairToken || "",
    enabled: stored.enabled !== false,
  };
  await chrome.storage.local.set(local);
  const sess = await chrome.storage.session.get(Object.keys(session));
  session = { ...session, ...sess };
  await pruneDeadTabs();
  // A restarted worker has lost its socket and event listeners, so any debugger it left
  // attached is orphaned (and keeps Chrome's "debugging this browser" bar up). Let go.
  await detachAll("worker_restart");
  for (const active of await chrome.tabs.query({ active: true })) await noteUserActive(active.id);
  updateBadge();
  if (local.enabled) connect();
})();

async function saveLocal() {
  await chrome.storage.local.set(local);
}

async function saveSession() {
  await chrome.storage.session.set(session);
}

/** Drop ids of tabs that no longer exist (the worker may have slept through closes). */
async function pruneDeadTabs() {
  const alive = new Set((await chrome.tabs.query({})).map((t) => t.id));
  session.agentTabs = session.agentTabs.filter((id) => alive.has(id));
  session.sharedTabs = session.sharedTabs.filter((id) => alive.has(id));
  session.attachedTabs = session.attachedTabs.filter((id) => alive.has(id));
  await saveSession();
}

/* Helpers ------------------------------------------------------------------- */

function sha256Bytes(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

async function sha256Hex(text) {
  return [...new Uint8Array(await sha256Bytes(text))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pairingCode(hostNonce, extNonce) {
  const digest = new DataView(await sha256Bytes(`${hostNonce}|${extNonce}`));
  return String(digest.getUint32(0) % 1000000).padStart(6, "0");
}

function randomNonce() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether Deyin may drive this URL. Mirrors classifyUrl() in chrome-protocol.ts. */
function urlVerdict(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `Not a valid URL: ${raw}` };
  }
  if (url.protocol === "about:") {
    return url.href === "about:blank" ? { ok: true } : { ok: false, reason: `Blocked page: ${url.href}` };
  }
  if (BLOCKED_SCHEMES.has(url.protocol)) {
    return { ok: false, reason: `Blocked page type (${url.protocol}). Chrome internal pages and extensions cannot be automated.` };
  }
  if (!["http:", "https:", "file:", "data:"].includes(url.protocol)) {
    return { ok: false, reason: `Unsupported URL scheme: ${url.protocol}` };
  }
  return { ok: true };
}

function tabUrl(tab) {
  return tab.pendingUrl || tab.url || "";
}

function isAgent(tabId) {
  return session.agentTabs.includes(tabId);
}

function isShared(tabId) {
  return session.sharedTabs.includes(tabId);
}

function isManaged(tabId) {
  return isAgent(tabId) || isShared(tabId);
}

function deyinGroupIds() {
  return new Set(Object.values(session.groups));
}

/** Chrome puts a tab opened from a grouped tab into the opener's group, so group membership marks agent popups. */
function inDeyinGroup(tab) {
  return typeof tab.groupId === "number" && tab.groupId >= 0 && deyinGroupIds().has(tab.groupId);
}

function inAgentWindow(tab) {
  return session.agentWindowId !== null && tab.windowId === session.agentWindowId;
}

async function addAgentTab(tabId) {
  if (session.agentTabs.includes(tabId)) return;
  session.agentTabs.push(tabId);
  await saveSession();
}

/** Remember which of the user's own tabs is active per window, so an agent popup can't keep the focus it steals. */
async function noteUserActive(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.incognito || isManaged(tab.id) || inDeyinGroup(tab) || inAgentWindow(tab)) return;
    session.userActive[tab.windowId] = tab.id;
    await saveSession();
  } catch {
    // tab closed meanwhile
  }
}

async function restoreUserTab(windowId, stolenBy) {
  const previous = session.userActive[windowId];
  if (previous === undefined || previous === stolenBy) return;
  try {
    const tab = await chrome.tabs.get(previous);
    if (!isManaged(tab.id)) await chrome.tabs.update(previous, { active: true });
  } catch {
    // the user's tab is gone; nothing to restore
  }
}

function toExtTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || "",
    url: tabUrl(tab),
    active: Boolean(tab.active),
    incognito: Boolean(tab.incognito),
    agent: isAgent(tab.id),
    shared: isShared(tab.id),
    attached: session.attachedTabs.includes(tab.id),
  };
}

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

async function managedTabs() {
  const tabs = [];
  for (const id of [...session.agentTabs, ...session.sharedTabs]) {
    try {
      tabs.push(toExtTab(await chrome.tabs.get(id)));
    } catch {
      // closed while we slept; pruned on next start
    }
  }
  return tabs;
}

async function sendState() {
  send({ type: "state", stopped: session.stopped, tabs: await managedTabs() });
}

async function emitTab(kind, tabId) {
  if (kind === "removed") return send({ type: "tabEvent", kind, tabId });
  try {
    send({ type: "tabEvent", kind, tabId, tab: toExtTab(await chrome.tabs.get(tabId)) });
  } catch {
    send({ type: "tabEvent", kind: "removed", tabId });
  }
}

function broadcastStatus() {
  updateBadge();
  chrome.runtime.sendMessage({ cmd: "status-changed" }).catch(() => undefined);
}

function updateBadge() {
  let text = "";
  let color = "#4f7cff";
  if (session.stopped) {
    text = "II";
    color = "#d93025";
  } else if (link === "pairing_confirm") {
    text = "!";
    color = "#f29900";
  } else if (link === "connected") {
    text = session.attachedTabs.length ? String(session.attachedTabs.length) : "";
  }
  chrome.action.setBadgeText({ text }).catch(() => undefined);
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => undefined);
}

/* Connection ---------------------------------------------------------------- */

function scheduleReconnect(afterMs) {
  if (reconnectTimer || !local.enabled) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, afterMs);
}

function connect() {
  if (!local.enabled || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
  const port = PORTS[portIndex];
  link = "searching";
  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  } catch {
    scheduleReconnect(reconnectDelay);
    return;
  }
  ws = socket;
  let opened = false;
  socket.onopen = () => {
    opened = true;
    reconnectDelay = RECONNECT_MIN_MS;
    send({
      type: "hello",
      v: PROTOCOL_VERSION,
      browserId: local.browserId,
      label: `Chrome (${(navigator.userAgentData && navigator.userAgentData.platform) || "browser"})`,
      userAgent: navigator.userAgent,
      extVersion: chrome.runtime.getManifest().version,
      ...(local.pairToken ? { pairToken: local.pairToken } : {}),
    });
  };
  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    ready.then(() => handleHostMessage(message)).catch((err) => console.warn("deyin: host message failed", err));
  };
  socket.onclose = () => {
    if (ws === socket) ws = null;
    const wasLinked = link === "connected";
    link = "off";
    pendingPair = null;
    if (wasLinked) {
      // The host is gone: stop driving anything, keep user-facing state.
      detachAll("host_disconnected").catch(() => undefined);
    }
    broadcastStatus();
    if (!opened) {
      // Nothing listening on this port: try the next one straight away, back off after a full round.
      portIndex = (portIndex + 1) % PORTS.length;
      portsTriedThisRound += 1;
      if (portsTriedThisRound < PORTS.length) {
        connect();
        return;
      }
    }
    portsTriedThisRound = 0;
    // Unpaired browsers poll slowly: there is nothing to resume, so don't hammer loopback.
    const wait = local.pairToken ? reconnectDelay : Math.max(reconnectDelay, SEARCH_BACKOFF_MS);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    scheduleReconnect(wait);
  };
  socket.onerror = () => undefined;
}

function disconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) ws.close();
  ws = null;
  link = "off";
}

async function handleHostMessage(message) {
  switch (message.type) {
    case "welcome":
      if (message.paired) {
        link = "connected";
        await sendState();
        broadcastStatus();
      } else if (message.pairing) {
        const extNonce = randomNonce();
        pendingPair = { commit: message.commit, extNonce, code: null, hostNonce: null };
        link = "pairing_wait";
        send({ type: "pairingNonce", nonce: extNonce });
        broadcastStatus();
      }
      return;
    case "pairingReveal": {
      if (!pendingPair || (await sha256Hex(message.nonce)) !== pendingPair.commit) {
        // The host changed its nonce after committing: abort, never show a code.
        pendingPair = null;
        if (ws) ws.close();
        return;
      }
      pendingPair.hostNonce = message.nonce;
      pendingPair.code = await pairingCode(message.nonce, pendingPair.extNonce);
      link = "pairing_confirm";
      broadcastStatus();
      // Best effort: surface the popup so the user sees the code. Not allowed everywhere.
      if (chrome.action.openPopup) chrome.action.openPopup().catch(() => undefined);
      return;
    }
    case "pairToken":
      local.pairToken = message.token;
      await saveLocal();
      link = "connected";
      pendingPair = null;
      await sendState();
      broadcastStatus();
      return;
    case "rejected":
      if (message.reason === "token") {
        // The host forgot this browser: drop the stale token so the next pairing starts clean.
        local.pairToken = "";
        await saveLocal();
      }
      broadcastStatus();
      return;
    case "ping":
      send({ type: "pong" });
      return;
    case "request":
      if (link !== "connected") {
        send({ type: "response", id: message.id, ok: false, error: "Not paired." });
        return;
      }
      try {
        const value = await runOp(message.op, message.args || {});
        send({ type: "response", id: message.id, ok: true, value });
      } catch (err) {
        send({ type: "response", id: message.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    default:
      return;
  }
}

/* Popup actions: pairing consent -------------------------------------------- */

function allowPairing() {
  if (link !== "pairing_confirm" || !pendingPair) return;
  send({ type: "paired" });
}

function denyPairing() {
  pendingPair = null;
  if (ws) ws.close();
}

/* Operations ---------------------------------------------------------------- */

const OPS_WHILE_STOPPED = new Set(["tabs.list", "control.stop", "control.resume"]);

async function runOp(op, args) {
  if (session.stopped && !OPS_WHILE_STOPPED.has(op)) {
    throw new Error("Chrome control is stopped. Resume it from the Deyin extension popup or in Deyin.");
  }
  switch (op) {
    case "tabs.list":
      return { tabs: await managedTabs() };
    case "tabs.create":
      return { tab: await createAgentTab(args) };
    case "tabs.close":
      return await closeAgentTab(args.tabId);
    case "tabs.reveal":
      return await revealTab(args.tabId);
    case "debugger.attach":
      return { tab: await attachTab(args.tabId) };
    case "debugger.detach":
      await detachTab(args.tabId, "host_request");
      return { ok: true };
    case "cdp":
      return { result: await runCdp(args) };
    case "control.stop":
      await stopAll("host");
      return { stopped: true };
    case "control.resume":
      if (session.stoppedBy === "extension") throw new Error("Stopped from the extension: resume it in the extension popup.");
      await resumeAll();
      return { stopped: false };
    default:
      throw new Error(`Unknown op: ${String(op)}`);
  }
}

async function requireManagedTab(tabId) {
  if (typeof tabId !== "number") throw new Error("tabId is required.");
  if (!isManaged(tabId)) throw new Error("That tab is not shared with Deyin. Share it from the extension popup, or let Deyin open its own tab.");
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error("That tab no longer exists.");
  }
  if (tab.incognito) throw new Error("Incognito tabs are never automated.");
  return tab;
}

/* Tabs ---------------------------------------------------------------------- */

async function liveGroupFor(windowId) {
  const known = session.groups[windowId];
  if (known === undefined) return null;
  try {
    const group = await chrome.tabGroups.get(known);
    return group.windowId === windowId ? known : null;
  } catch {
    return null;
  }
}

async function groupAgentTab(tab) {
  const existing = await liveGroupFor(tab.windowId);
  const groupId = await chrome.tabs.group(existing === null ? { tabIds: [tab.id], createProperties: { windowId: tab.windowId } } : { tabIds: [tab.id], groupId: existing });
  if (existing === null) {
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "blue", collapsed: false });
  }
  session.groups[tab.windowId] = groupId;
}

async function createAgentTab(args) {
  const url = typeof args.url === "string" && args.url ? args.url : "about:blank";
  const verdict = urlVerdict(url);
  if (!verdict.ok) throw new Error(verdict.reason);
  const strategy = args.strategy === "window" ? "window" : "group";
  let tab;

  if (strategy === "window") {
    tab = await createInAgentWindow(url);
  } else {
    let window = null;
    try {
      window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    } catch {
      window = null;
    }
    if (!window || window.incognito || window.id === undefined) {
      tab = await createInAgentWindow(url);
    } else {
      tab = await chrome.tabs.create({ windowId: window.id, url, active: false });
      await groupAgentTab(tab);
    }
  }

  await addAgentTab(tab.id);
  if (args.reveal === true) await revealTab(tab.id);
  const fresh = await chrome.tabs.get(tab.id);
  // Awaited so the host has the tab in its cache before it sees the response.
  await emitTab("created", tab.id);
  broadcastStatus();
  return toExtTab(fresh);
}

/** A separate, unfocused window just for Deyin's tabs (the "window" strategy and the no-window fallback). */
async function createInAgentWindow(url) {
  if (session.agentWindowId !== null) {
    try {
      const existing = await chrome.windows.get(session.agentWindowId);
      if (!existing.incognito) return await chrome.tabs.create({ windowId: existing.id, url, active: false });
    } catch {
      session.agentWindowId = null;
    }
  }
  const created = await chrome.windows.create({ url, focused: false, type: "normal" });
  session.agentWindowId = created.id ?? null;
  const first = created.tabs && created.tabs[0];
  if (!first) throw new Error("Chrome did not create a tab.");
  return first;
}

async function closeAgentTab(tabId) {
  if (typeof tabId !== "number" || !isAgent(tabId)) {
    throw new Error("Only tabs Deyin opened can be closed by Deyin. Shared tabs are released, not closed.");
  }
  await detachTab(tabId, "closed");
  await chrome.tabs.remove(tabId).catch(() => undefined);
  return { closed: true };
}

async function revealTab(tabId) {
  const tab = await requireManagedTab(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: true };
}

/* Debugger ------------------------------------------------------------------ */

async function attachTab(tabId) {
  const tab = await requireManagedTab(tabId);
  const verdict = urlVerdict(tabUrl(tab) || "about:blank");
  if (!verdict.ok) throw new Error(verdict.reason);
  if (!session.attachedTabs.includes(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3");
    session.attachedTabs.push(tabId);
    await saveSession();
    // A background tab renders and takes input only if the page believes it is focused.
    try {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch (err) {
      await detachTab(tabId, "attach_failed");
      throw err;
    }
  }
  await emitTab("updated", tabId);
  broadcastStatus();
  return toExtTab(await chrome.tabs.get(tabId));
}

async function detachTab(tabId, reason) {
  if (!session.attachedTabs.includes(tabId)) return;
  session.attachedTabs = session.attachedTabs.filter((id) => id !== tabId);
  await saveSession();
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already detached (tab closed or user cancelled the infobar)
  }
  send({ type: "detached", tabId, reason });
  broadcastStatus();
}

async function detachAll(reason) {
  for (const id of [...session.attachedTabs]) await detachTab(id, reason);
}

function sanitizeEvent(method, params) {
  // Network events carry headers (cookies, auth). Deyin only needs method, url and status.
  if (method === "Network.requestWillBeSent") {
    return { requestId: params.requestId, request: { url: params.request && params.request.url, method: params.request && params.request.method } };
  }
  if (method === "Network.responseReceived") {
    return { requestId: params.requestId, response: { url: params.response && params.response.url, status: params.response && params.response.status } };
  }
  if (method === "Network.loadingFailed") {
    return { requestId: params.requestId, errorText: params.errorText, canceled: params.canceled };
  }
  return params;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || !session.attachedTabs.includes(source.tabId)) return;
  if (!EVENTS_FORWARDED.has(method)) return;
  send({ type: "event", tabId: source.tabId, method, params: sanitizeEvent(method, params || {}) });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId === undefined || !session.attachedTabs.includes(tabId)) return;
  session.attachedTabs = session.attachedTabs.filter((id) => id !== tabId);
  saveSession();
  send({ type: "detached", tabId, reason });
  broadcastStatus();
  // Dismissing Chrome's "is debugging this browser" bar is an explicit user "stop".
  if (reason === "canceled_by_user") stopAll("extension").catch(() => undefined);
});

async function runCdp(args) {
  const { tabId, method } = args;
  if (typeof method !== "string" || !CDP_ALLOWED.has(method)) throw new Error(`CDP method not allowed: ${String(method)}`);
  await requireManagedTab(tabId);
  if (!session.attachedTabs.includes(tabId)) throw new Error("Debugger is not attached to this tab.");
  const timeoutMs = typeof args.timeoutMs === "number" ? Math.min(Math.max(args.timeoutMs, 500), 120000) : DEFAULT_CDP_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  try {
    return await Promise.race([chrome.debugger.sendCommand({ tabId }, method, args.params || {}), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/* Stop / resume ------------------------------------------------------------- */

async function stopAll(by) {
  session.stopped = true;
  session.stoppedBy = by;
  await saveSession();
  await detachAll("stopped");
  send({ type: "stopped", stopped: true });
  broadcastStatus();
}

async function resumeAll() {
  session.stopped = false;
  session.stoppedBy = null;
  await saveSession();
  send({ type: "stopped", stopped: false });
  broadcastStatus();
}

/* Tab lifecycle ------------------------------------------------------------- */

chrome.tabs.onCreated.addListener((tab) => {
  ready.then(async () => {
    if (tab.incognito || isAgent(tab.id)) return;
    // A popup from an agent tab (window.open, target=_blank) stays with Deyin: Chrome puts it in the
    // opener's group, and it opens in the foreground, so give the user their tab back.
    const fromAgent =
      inDeyinGroup(tab) || (tab.openerTabId !== undefined && isAgent(tab.openerTabId)) || inAgentWindow(tab);
    if (!fromAgent) return;
    await addAgentTab(tab.id);
    if (!inDeyinGroup(tab) && !inAgentWindow(tab)) await groupAgentTab(tab).catch(() => undefined);
    if (tab.active) await restoreUserTab(tab.windowId, tab.id);
    await emitTab("created", tab.id);
    broadcastStatus();
  });
});

chrome.tabs.onActivated.addListener((info) => {
  ready.then(() => noteUserActive(info.tabId));
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  ready.then(async () => {
    if (!isManaged(tabId)) return;
    if (change.url && session.attachedTabs.includes(tabId) && !urlVerdict(change.url).ok) {
      // A driven tab wandered onto a browser-internal page: let go immediately.
      await detachTab(tabId, "blocked_url");
    }
    if (change.url !== undefined || change.title !== undefined || change.status !== undefined) emitTab("updated", tabId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(async () => {
    const managed = isManaged(tabId);
    session.agentTabs = session.agentTabs.filter((id) => id !== tabId);
    session.sharedTabs = session.sharedTabs.filter((id) => id !== tabId);
    session.attachedTabs = session.attachedTabs.filter((id) => id !== tabId);
    await saveSession();
    if (managed) emitTab("removed", tabId);
    broadcastStatus();
  });
});

chrome.alarms.create("deyin-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "deyin-keepalive") return;
  ready.then(() => {
    if (local.enabled && !ws) connect();
  });
});

/* Popup API ----------------------------------------------------------------- */

async function popupStatus() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let activeTab = null;
  if (active && active.id !== undefined) {
    const url = tabUrl(active);
    const verdict = urlVerdict(url || "about:blank");
    let reason = "";
    if (active.incognito) reason = "Incognito tabs can't be shared.";
    else if (!verdict.ok) reason = verdict.reason;
    activeTab = {
      id: active.id,
      title: active.title || url,
      url,
      shared: isShared(active.id),
      agent: isAgent(active.id),
      canShare: !reason && !isAgent(active.id),
      reason,
    };
  }
  return {
    link,
    paired: Boolean(local.pairToken),
    enabled: local.enabled,
    code: pendingPair ? pendingPair.code : null,
    stopped: session.stopped,
    stoppedBy: session.stoppedBy,
    agentTabs: session.agentTabs.length,
    sharedTabs: session.sharedTabs.length,
    attached: session.attachedTabs.length,
    activeTab,
  };
}

async function popupCommand(message) {
  switch (message.cmd) {
    case "get-status":
      return await popupStatus();
    case "allow":
      allowPairing();
      return await popupStatus();
    case "deny":
      denyPairing();
      return await popupStatus();
    case "stop":
      await stopAll("extension");
      return await popupStatus();
    case "resume":
      await resumeAll();
      return await popupStatus();
    case "share-active": {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!active || active.id === undefined) return await popupStatus();
      if (isShared(active.id)) {
        await detachTab(active.id, "unshared");
        session.sharedTabs = session.sharedTabs.filter((id) => id !== active.id);
        await saveSession();
        emitTab("unshared", active.id);
      } else if (!active.incognito && !isAgent(active.id) && urlVerdict(tabUrl(active) || "about:blank").ok) {
        session.sharedTabs.push(active.id);
        await saveSession();
        emitTab("shared", active.id);
      }
      broadcastStatus();
      return await popupStatus();
    }
    case "set-enabled":
      local.enabled = Boolean(message.enabled);
      await saveLocal();
      if (local.enabled) {
        reconnectDelay = RECONNECT_MIN_MS;
        connect();
      } else {
        await detachAll("disabled");
        disconnect();
      }
      broadcastStatus();
      return await popupStatus();
    case "forget":
      local.pairToken = "";
      await saveLocal();
      await detachAll("forgotten");
      if (ws) ws.close();
      broadcastStatus();
      return await popupStatus();
    case "close-agent-tabs": {
      for (const id of [...session.agentTabs]) await closeAgentTab(id).catch(() => undefined);
      broadcastStatus();
      return await popupStatus();
    }
    default:
      return await popupStatus();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only our own popup may drive these controls.
  if (sender.id !== chrome.runtime.id || !message || typeof message.cmd !== "string") return false;
  ready
    .then(() => popupCommand(message))
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
  return true;
});

chrome.runtime.onStartup.addListener(() => {
  ready.then(() => local.enabled && connect());
});
chrome.runtime.onInstalled.addListener(() => {
  ready.then(() => local.enabled && connect());
});
