import { BrowserWindow, screen, type Display } from "electron";
import { COMPUTER_USE_STOP_CHORD_LABEL, computerUsePhaseLabel, type ComputerUseState } from "@deyin/contract";
import { overlayBorderHtml, overlayPillHtml, OVERLAY_ACTION_PREFIX } from "./computer-use-overlay-html.js";

/**
 * The "Deyin is controlling your computer" indication, drawn on the desktop so it is visible even when Deyin's
 * own window is not on screen:
 *
 *   - a glowing screen-edge border (with a ripple where the agent is about to click) while the real mouse and
 *     keyboard are in use, and an amber one when the user took over;
 *   - a small pill with the app being driven and Stop (Resume as well while paused).
 *
 * Every window here is click-through or non-activating, excluded from screen capture, untitled and a tool
 * window, so it never takes focus, never shows up in the agent's screenshots, and is not listed as a window the
 * agent could act on.
 */

const PILL_SIZE = { width: 420, height: 52 };
/** Between two actions the state is briefly idle; keep the pill up so a chain of actions looks like one task. */
const LINGER_MS = 3_500;
/** Free the renderer processes when computer use has been quiet for a while. */
const DESTROY_AFTER_MS = 45_000;

interface OverlayOptions {
  /** The user's setting; checked on every update so toggling it takes effect at once. */
  isEnabled: () => boolean;
  onStop: () => void;
  onResume: () => void;
}

interface Surface {
  window: BrowserWindow;
  ready: Promise<void>;
}

function secureWindow(window: BrowserWindow): void {
  window.setTitle("");
  window.on("page-title-updated", (event) => event.preventDefault());
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setContentProtection(true);
}

export class ComputerUseOverlay {
  private borders = new Map<number, Surface>();
  private pill: Surface | null = null;
  private lingerTimer: NodeJS.Timeout | null = null;
  private destroyTimer: NodeJS.Timeout | null = null;
  private shown = false;
  private lastState: ComputerUseState = { phase: "idle" };
  private lastCue = "";
  private lastDisplay: Display | null = null;

  constructor(private readonly opts: OverlayOptions) {}

  /** Apply the latest state. Cheap to call on every change. */
  update(state: ComputerUseState): void {
    this.lastState = state;
    if (!this.opts.isEnabled()) {
      this.hide();
      return;
    }
    if (state.phase === "idle") {
      this.lastCue = "";
      this.scheduleHide();
      return;
    }
    this.clearTimers();
    this.show(state);
  }

  dispose(): void {
    this.clearTimers();
    this.destroyAll();
  }

  /* Showing and hiding ----------------------------------------------------------- */

  private show(state: ComputerUseState): void {
    const target = this.displayFor(state);
    this.ensureSurfaces();
    this.shown = true;

    const label = computerUsePhaseLabel(state);
    void this.pushPill({ phase: state.phase, label, chord: COMPUTER_USE_STOP_CHORD_LABEL });

    for (const display of screen.getAllDisplays()) {
      const surface = this.borders.get(display.id);
      if (!surface) continue;
      const wantsBorder = (state.phase === "input" || state.phase === "paused") && display.id === target.id;
      void this.pushBorder(surface, { phase: wantsBorder ? state.phase : "off" });
    }
    this.placePill(target);
    if (state.phase === "input" && state.point) this.cueAt(state.point, target);
    if (this.pill && !this.pill.window.isVisible()) this.pill.window.showInactive();
    for (const surface of this.borders.values()) {
      if (!surface.window.isVisible()) surface.window.showInactive();
    }
  }

  private scheduleHide(): void {
    if (!this.shown || this.lingerTimer) return;
    // The border means "the real mouse is moving"; it goes at once. The pill lingers.
    for (const surface of this.borders.values()) void this.pushBorder(surface, { phase: "off" });
    void this.pushPill({ phase: "idle", label: "Deyin is working", chord: COMPUTER_USE_STOP_CHORD_LABEL });
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      this.hide();
    }, LINGER_MS);
  }

  private hide(): void {
    this.clearTimers();
    if (!this.shown && this.borders.size === 0 && !this.pill) return;
    this.shown = false;
    this.pill?.window.hide();
    for (const surface of this.borders.values()) surface.window.hide();
    this.destroyTimer = setTimeout(() => this.destroyAll(), DESTROY_AFTER_MS);
  }

  private clearTimers(): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    if (this.destroyTimer) clearTimeout(this.destroyTimer);
    this.lingerTimer = null;
    this.destroyTimer = null;
  }

  private destroyAll(): void {
    for (const surface of this.borders.values()) if (!surface.window.isDestroyed()) surface.window.destroy();
    this.borders.clear();
    if (this.pill && !this.pill.window.isDestroyed()) this.pill.window.destroy();
    this.pill = null;
  }

  /* Windows ------------------------------------------------------------------------ */

  private displayFor(state: ComputerUseState): Display {
    if (state.point) {
      // The host reports physical pixels; Electron places windows in DIPs.
      return screen.getDisplayNearestPoint(screen.screenToDipPoint(state.point));
    }
    const active = this.lastDisplay;
    return active ?? screen.getPrimaryDisplay();
  }

  private ensureSurfaces(): void {
    const displays = screen.getAllDisplays();
    // A display that came or went since the last time: start from a clean slate.
    const known = [...this.borders.keys()].sort().join(",");
    const current = displays.map((d) => d.id).sort().join(",");
    if (known !== current) {
      for (const surface of this.borders.values()) if (!surface.window.isDestroyed()) surface.window.destroy();
      this.borders.clear();
    }
    for (const display of displays) {
      const existing = this.borders.get(display.id);
      if (existing && !existing.window.isDestroyed()) continue;
      this.borders.set(display.id, this.createBorder(display));
    }
    if (!this.pill || this.pill.window.isDestroyed()) this.pill = this.createPill();
  }

  private createBorder(display: Display): Surface {
    const window = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      thickFrame: false,
      type: "toolbar",
      title: "",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    secureWindow(window);
    window.setIgnoreMouseEvents(true);
    // Windows can round the bounds of a DIP-scaled window; set them again after creation.
    window.setBounds(display.bounds);
    const ready = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayBorderHtml())}`);
    return { window, ready: ready.catch(() => undefined) };
  }

  private createPill(): Surface {
    const window = new BrowserWindow({
      ...PILL_SIZE,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // Clickable, but never takes focus away from the app being driven.
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      thickFrame: false,
      type: "toolbar",
      title: "",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    secureWindow(window);
    // The page has no preload: its buttons log a line that starts with the action prefix, read here.
    window.webContents.on("console-message", (event) => {
      if (!event.message.startsWith(OVERLAY_ACTION_PREFIX)) return;
      const action = event.message.slice(OVERLAY_ACTION_PREFIX.length);
      if (action === "stop") this.opts.onStop();
      else if (action === "resume") this.opts.onResume();
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const ready = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayPillHtml())}`);
    return { window, ready: ready.catch(() => undefined) };
  }

  private placePill(display: Display): void {
    if (!this.pill || this.pill.window.isDestroyed()) return;
    this.lastDisplay = display;
    const { x, y, width } = display.workArea;
    this.pill.window.setBounds({
      x: Math.round(x + (width - PILL_SIZE.width) / 2),
      y: y + 12,
      ...PILL_SIZE,
    });
  }

  /* Pushing state into the pages ------------------------------------------------- */

  private async run(surface: Surface, script: string): Promise<void> {
    await surface.ready;
    if (surface.window.isDestroyed()) return;
    await surface.window.webContents.executeJavaScript(script, false).catch(() => undefined);
  }

  private pushPill(payload: { phase: ComputerUseState["phase"]; label: string; chord: string }): Promise<void> {
    if (!this.pill) return Promise.resolve();
    return this.run(this.pill, `window.__set(${JSON.stringify(payload)})`);
  }

  private pushBorder(surface: Surface, payload: { phase: ComputerUseState["phase"] | "off" }): Promise<void> {
    return this.run(surface, `window.__set(${JSON.stringify(payload)})`);
  }

  /** A ripple where the real mouse is about to click, so the user sees it before it happens. */
  private cueAt(point: { x: number; y: number }, display: Display): void {
    const key = `${display.id}:${point.x},${point.y}`;
    if (key === this.lastCue) return;
    this.lastCue = key;
    const surface = this.borders.get(display.id);
    if (!surface) return;
    const dip = screen.screenToDipPoint(point);
    const local = { x: Math.round(dip.x - display.bounds.x), y: Math.round(dip.y - display.bounds.y) };
    void this.run(surface, `window.__cue(${local.x}, ${local.y})`);
  }

  /** Last state applied, for tests and diagnostics. */
  get state(): ComputerUseState {
    return this.lastState;
  }
}
