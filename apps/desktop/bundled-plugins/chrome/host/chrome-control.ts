import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CdpPage, type CdpTransport } from "../../browser/host/cdp-page.js";
import type { BridgeSnapshot, ChromeBridge } from "./chrome-bridge.js";
import { classifyUrl, isLocalOrigin, type ExtTab } from "./chrome-protocol.js";

/**
 * Per-conversation control of tabs in the user's real Chrome.
 *
 * Deyin only ever works in tabs it opened itself (a "Deyin" group of background
 * tabs, so the user's own tabs and focus are left alone) or tabs the user
 * explicitly shared from the extension popup. Each agent tab belongs to the
 * conversation that opened it. Commands for one tab run one at a time.
 */

export type OriginDecision = "always" | "once" | "deny";

export interface OriginApprovalRequest {
  origin: string;
  /** What the agent is trying to do, e.g. "open", "navigate", "read". */
  action: string;
  threadId: string;
}

export interface ChromeControlDeps {
  bridge: ChromeBridge;
  /** JSON file that persists origins the user chose "always allow" for. */
  approvedOriginsFile: string;
  /** Where new tabs go: a group in the current window, or a separate window. */
  strategy: () => "group" | "window";
  requestOriginApproval: (request: OriginApprovalRequest) => Promise<OriginDecision>;
  /** Store a screenshot for a thread; returns the stored file name or null. */
  saveImage?: (threadId: string, image: { base64: string; mediaType: string }) => string | null;
}

const MAX_AGENT_TABS_PER_THREAD = 8;
const IDLE_AFTER_MS = 3000;
const DEFAULT_THREAD = "default";

/** CDP over the relay for one tab. */
class BridgeTransport implements CdpTransport {
  private readonly handlers = new Map<string, Set<(params: unknown) => void>>();
  private emulationDirty = false;

  constructor(
    private readonly bridge: ChromeBridge,
    readonly tabId: number,
  ) {}

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, opts?: { timeoutMs?: number }): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const response = await this.bridge.request<{ result: T }>("cdp", { tabId: this.tabId, method, params, timeoutMs }, timeoutMs + 5000);
    return response.result;
  }

  on(method: string, handler: (params: unknown) => void): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  dispatch(method: string, params: unknown): void {
    // A top-level navigation can swap the renderer, which drops focus emulation.
    if (method === "Page.frameNavigated" && !(params as { frame?: { parentId?: string } }).frame?.parentId) this.emulationDirty = true;
    for (const handler of this.handlers.get(method) ?? []) handler(params);
  }

  async ensureRenderable(): Promise<void> {
    if (!this.emulationDirty) return;
    this.emulationDirty = false;
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  }
}

interface Slot {
  tabId: number;
  transport: BridgeTransport;
  page: CdpPage;
  queue: Promise<unknown>;
  attached: boolean;
}

export interface RunOptions {
  /** Check the tab's current origin before running. Off for navigation, which leaves it. */
  checkCurrentOrigin?: boolean;
  signal?: AbortSignal;
}

export class ChromeControlError extends Error {}

export class ChromeControl extends EventEmitter {
  private readonly bridge: ChromeBridge;
  private readonly slots = new Map<number, Slot>();
  /** tabId → conversation that opened it. Tabs missing here are orphans and get adopted on first use. */
  private readonly owners = new Map<number, string>();
  private readonly current = new Map<string, number>();
  private approved: Set<string>;
  private readonly sessionApproved = new Map<string, Set<string>>();
  private readonly pendingApprovals = new Map<string, Promise<void>>();
  /** Origin a shared tab was on when the user shared it; staying there needs no approval. */
  private readonly sharedBase = new Map<number, string>();
  private active = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ChromeControlDeps) {
    super();
    this.bridge = deps.bridge;
    this.approved = new Set(this.loadApproved());

    this.bridge.on("cdp", (tabId: number, method: string, params: unknown) => this.slots.get(tabId)?.transport.dispatch(method, params));
    this.bridge.on("detached", (tabId: number) => this.markDetached(tabId));
    this.bridge.on("disconnected", () => this.markAllDetached());
    this.bridge.on("stopped", (stopped: boolean) => {
      if (!stopped) return;
      this.markAllDetached();
      this.setActive(false);
    });
    this.bridge.on("tab", (kind: string, tabId: number, tab?: ExtTab) => {
      if (kind === "removed") this.forgetTab(tabId);
      else if (kind === "shared" && tab) this.rememberSharedBase(tab);
    });
  }

  /* Approved origins ------------------------------------------------------------ */

  private loadApproved(): string[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.deps.approvedOriginsFile, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === "string") : [];
    } catch {
      return [];
    }
  }

  getApprovedOrigins(): string[] {
    return [...this.approved].sort();
  }

  setApprovedOrigins(origins: readonly string[]): string[] {
    const next = new Set<string>();
    for (const raw of origins) {
      try {
        const origin = new URL(raw).origin;
        if (origin !== "null") next.add(origin);
      } catch {
        // ignore anything that is not a URL
      }
    }
    this.approved = next;
    mkdirSync(dirname(this.deps.approvedOriginsFile), { recursive: true });
    writeFileSync(this.deps.approvedOriginsFile, JSON.stringify([...next].sort(), null, 2));
    return this.getApprovedOrigins();
  }

  private rememberSharedBase(tab: ExtTab): void {
    const verdict = classifyUrl(tab.url || "about:blank");
    if (verdict.ok && verdict.origin) this.sharedBase.set(tab.id, verdict.origin);
  }

  /**
   * Throws unless Deyin may touch `url`. Browser-internal pages are refused
   * outright; other origins need the user's approval once (local pages,
   * about:blank and data: never do).
   */
  async ensureOriginAllowed(threadId: string, url: string, action: string, tabId?: number): Promise<void> {
    const verdict = classifyUrl(url || "about:blank");
    if (!verdict.ok) throw new ChromeControlError(verdict.reason);
    const { origin } = verdict;
    if (!origin || origin === "file://" || isLocalOrigin(origin)) return;
    if (tabId !== undefined && this.sharedBase.get(tabId) === origin) return;
    if (this.approved.has(origin) || this.sessionApproved.get(threadId)?.has(origin)) return;

    const key = `${threadId}|${origin}`;
    let pending = this.pendingApprovals.get(key);
    if (!pending) {
      pending = this.askOrigin(threadId, origin, action).finally(() => this.pendingApprovals.delete(key));
      this.pendingApprovals.set(key, pending);
    }
    await pending;
  }

  private async askOrigin(threadId: string, origin: string, action: string): Promise<void> {
    const decision = await this.deps.requestOriginApproval({ origin, action, threadId });
    switch (decision) {
      case "always":
        this.setApprovedOrigins([...this.approved, origin]);
        return;
      case "once": {
        const set = this.sessionApproved.get(threadId) ?? new Set<string>();
        set.add(origin);
        this.sessionApproved.set(threadId, set);
        return;
      }
      case "deny":
        throw new ChromeControlError(`The user did not allow Deyin to use ${origin} in Chrome. Don't retry; ask them first.`);
      default: {
        const _exhaustive: never = decision;
        throw new ChromeControlError(`Unexpected approval result: ${String(_exhaustive)}`);
      }
    }
  }

  /* Activity -------------------------------------------------------------------- */

  isActive(): boolean {
    return this.active;
  }

  private setActive(active: boolean): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (active) {
      this.idleTimer = setTimeout(() => this.setActive(false), IDLE_AFTER_MS);
      this.idleTimer.unref();
    }
    if (this.active === active) return;
    this.active = active;
    this.emit("activity", active);
  }

  /* Tabs ------------------------------------------------------------------------ */

  private tabInfo(tabId: number): ExtTab | undefined {
    return this.bridge.snapshot().tabs.find((t) => t.id === tabId);
  }

  /** Tabs this conversation may use: its own, unclaimed agent tabs, and shared tabs. */
  tabsFor(threadId: string): ExtTab[] {
    return this.bridge.snapshot().tabs.filter((t) => t.shared || (t.agent && (this.owners.get(t.id) ?? threadId) === threadId));
  }

  currentTabId(threadId: string): number | undefined {
    return this.current.get(threadId);
  }

  /** Make `tabId` the conversation's default target. */
  useTab(threadId: string, tabId: number): ExtTab {
    const tab = this.resolveTab(threadId, tabId);
    this.current.set(threadId, tab.id);
    return tab;
  }

  private resolveTab(threadId: string, tabId?: number): ExtTab {
    const id = tabId ?? this.current.get(threadId);
    if (id === undefined) {
      throw new ChromeControlError("No Chrome tab selected. Call chrome_open to open one, or ask the user to share a tab from the Deyin extension popup.");
    }
    const tab = this.tabInfo(id);
    if (!tab) throw new ChromeControlError(`Chrome tab ${id} is not available (it was closed or never shared). Use chrome_tabs to list usable tabs.`);
    if (tab.agent && !tab.shared) {
      const owner = this.owners.get(id);
      if (owner && owner !== threadId) throw new ChromeControlError(`Chrome tab ${id} belongs to another conversation.`);
      if (!owner) this.owners.set(id, threadId);
    }
    return tab;
  }

  /**
   * Open a blank background tab for the conversation. Callers navigate it after
   * the debugger attaches, so the initial page load's console and network
   * output are captured.
   */
  async open(threadId: string, reveal: boolean): Promise<ExtTab> {
    const owned = [...this.owners.entries()].filter(([, owner]) => owner === threadId).length;
    if (owned >= MAX_AGENT_TABS_PER_THREAD) {
      throw new ChromeControlError(`This conversation already has ${owned} Chrome tabs open. Close one with chrome_tabs (action: close) first.`);
    }
    const { tab } = await this.bridge.request<{ tab: ExtTab }>("tabs.create", {
      url: "about:blank",
      strategy: this.deps.strategy(),
      reveal,
    });
    this.setActive(true);
    this.owners.set(tab.id, threadId);
    this.current.set(threadId, tab.id);
    this.emit("tabs");
    return tab;
  }

  async closeTab(threadId: string, tabId: number): Promise<void> {
    const tab = this.resolveTab(threadId, tabId);
    if (!tab.agent) throw new ChromeControlError("Only tabs Deyin opened can be closed. Shared tabs stay open; the user can stop sharing them.");
    await this.bridge.request("tabs.close", { tabId: tab.id });
    this.forgetTab(tab.id);
  }

  async revealTab(threadId: string, tabId: number): Promise<void> {
    const tab = this.resolveTab(threadId, tabId);
    await this.bridge.request("tabs.reveal", { tabId: tab.id });
  }

  /** Close every tab a conversation opened (used when the conversation goes away). */
  async releaseThread(threadId: string): Promise<void> {
    const ids = [...this.owners.entries()].filter(([, owner]) => owner === threadId).map(([id]) => id);
    for (const id of ids) {
      await this.bridge.request("tabs.close", { tabId: id }).catch(() => undefined);
      this.forgetTab(id);
    }
    this.sessionApproved.delete(threadId);
    this.current.delete(threadId);
  }

  async closeAllAgentTabs(): Promise<void> {
    for (const tab of this.bridge.snapshot().tabs.filter((t) => t.agent)) {
      await this.bridge.request("tabs.close", { tabId: tab.id }).catch(() => undefined);
      this.forgetTab(tab.id);
    }
  }

  ownerOf(tabId: number): string | undefined {
    return this.owners.get(tabId);
  }

  private forgetTab(tabId: number): void {
    this.owners.delete(tabId);
    this.sharedBase.delete(tabId);
    for (const [thread, id] of this.current) if (id === tabId) this.current.delete(thread);
    this.dropSlot(tabId);
    this.emit("tabs");
  }

  /* Stop / resume --------------------------------------------------------------- */

  async stop(): Promise<void> {
    this.bridge.abortPending("Chrome control was stopped.");
    if (this.bridge.isConnected()) await this.bridge.request("control.stop", {}, 5000).catch(() => undefined);
    this.markAllDetached();
    this.setActive(false);
  }

  async resume(): Promise<void> {
    await this.bridge.request("control.resume", {}, 5000);
  }

  /* Running commands ------------------------------------------------------------ */

  private slotFor(tabId: number): Slot {
    let slot = this.slots.get(tabId);
    if (!slot) {
      const transport = new BridgeTransport(this.bridge, tabId);
      slot = { tabId, transport, page: new CdpPage(transport), queue: Promise.resolve(), attached: false };
      this.slots.set(tabId, slot);
    }
    return slot;
  }

  private dropSlot(tabId: number): void {
    this.slots.get(tabId)?.page.dispose();
    this.slots.delete(tabId);
  }

  private markDetached(tabId: number): void {
    const slot = this.slots.get(tabId);
    if (!slot) return;
    slot.page.dispose();
    slot.attached = false;
    slot.page = new CdpPage(slot.transport);
  }

  private markAllDetached(): void {
    for (const id of this.slots.keys()) this.markDetached(id);
  }

  private async ensureAttached(slot: Slot): Promise<void> {
    if (slot.attached) return;
    await this.bridge.request("debugger.attach", { tabId: slot.tabId });
    slot.attached = true;
    try {
      await slot.page.init();
    } catch (err) {
      slot.attached = false;
      await this.bridge.request("debugger.detach", { tabId: slot.tabId }).catch(() => undefined);
      slot.page.dispose();
      slot.page = new CdpPage(slot.transport);
      throw err;
    }
  }

  /**
   * Run `fn` against a tab's page: serialized per tab, attaching the debugger
   * on first use and checking the tab's origin first.
   */
  async withPage<T>(
    threadId: string | undefined,
    tabId: number | undefined,
    action: string,
    fn: (page: CdpPage, tab: ExtTab) => Promise<T>,
    opts: RunOptions = {},
  ): Promise<T> {
    const thread = threadId ?? DEFAULT_THREAD;
    const tab = this.resolveTab(thread, tabId);
    const slot = this.slotFor(tab.id);
    const task = async (): Promise<T> => {
      if (opts.signal?.aborted) throw new ChromeControlError("Cancelled.");
      const live = this.tabInfo(tab.id);
      if (!live) throw new ChromeControlError(`Chrome tab ${tab.id} was closed.`);
      if (opts.checkCurrentOrigin !== false) await this.ensureOriginAllowed(thread, live.url, action, tab.id);
      await this.ensureAttached(slot);
      this.current.set(thread, tab.id);
      this.setActive(true);
      return await fn(slot.page, live);
    };
    const run = slot.queue.then(task, task);
    slot.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  /** After navigation: the final URL may be a redirect to an origin the user has not approved. */
  async verifyLanded(threadId: string | undefined, tabId: number, page: CdpPage): Promise<void> {
    const thread = threadId ?? DEFAULT_THREAD;
    const { url } = await page.info();
    try {
      await this.ensureOriginAllowed(thread, url, "navigate", tabId);
    } catch (err) {
      // Don't leave the agent sitting on a page the user refused.
      await page.navigate("about:blank").catch(() => undefined);
      throw err;
    }
  }

  saveImage(threadId: string | undefined, image: { base64: string; mediaType: string }): string | null {
    return this.deps.saveImage?.(threadId ?? DEFAULT_THREAD, image) ?? null;
  }

  status(): BridgeSnapshot {
    return this.bridge.snapshot();
  }
}
