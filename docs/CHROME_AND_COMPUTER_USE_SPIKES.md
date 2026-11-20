# Chrome module and computer use: spike results

Measured on Windows 11 (build 26300), Chrome 157.0.8103.79, a 2560x1440 display at 100% scaling.
Scripts: [`scripts/spikes/chrome-hidden-tab.mjs`](../scripts/spikes/chrome-hidden-tab.mjs) and
[`scripts/spikes/printwindow.ps1`](../scripts/spikes/printwindow.ps1). Re-run them on any machine before
changing the strategies below.

## 1. Hidden (agent-owned) Chrome tabs

The extension drives tabs with `chrome.debugger`, which exposes the same CDP domains as a debugging port, so
the spike talks CDP directly to a throwaway Chrome profile.

What was observed:

- **A plain background tab is unusable.** `document.visibilityState` is `hidden`, `requestAnimationFrame` never
  fires, `Input.dispatchMouseEvent` hangs until it times out, and `Page.captureScreenshot` times out.
- **`Emulation.setFocusEmulationEnabled(true)` fixes rendering and input.** `visibilityState` becomes `visible`,
  rAF runs, and a trusted click completes in about 170 ms. The user's own tab keeps focus (`hasFocus` unchanged),
  so nothing the user is looking at moves.
- **Screenshots of a hidden tab are the weak spot.** Over 8 interleaved click/screenshot rounds, a background tab
  in the same window and an unfocused separate window were both 8/8. Fresh tabs sometimes stall the first
  capture. A capture issued before focus emulation stalls the compositor request and poisons later captures on
  that tab, so emulation must be enabled at attach time, before any input or capture. One retry fixed every
  stall seen, including a minimized window (0/8 first try, 8/8 with one retry).
- `Page.captureScreenshot` with `fromSurface: false` returns a nearly blank image on a hidden tab. Do not use it.

Decisions that follow:

1. Agent tabs open with `active: false` in a "Deyin" tab group in the user's current window (default strategy
   `group`). A separate unfocused window (`window`) is available as a setting and is the fallback when a user
   finds group tabs too visible.
2. Focus emulation is enabled in the same step that attaches the debugger, before any command is forwarded.
3. Screenshots use a short timeout plus one retry, then fail with an error that points at `chrome_snapshot`
   instead of hanging. A `reveal: true` option may foreground the tab for one capture (ask tier).
4. Input commands check `document.visibilityState` first and re-apply emulation if needed, instead of sending
   input that would hang and land later.

## 2. Background window capture on Windows

`PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)` (flag `0x2`) captured real pixels from windows that were not in
the foreground and were covered by other windows, without activating them:

- Chrome (covered): 2107 distinct colors in a 3000-pixel sample.
- Cursor (Electron, covered): 111 distinct colors (a dark UI).
- Desktop shell: 2388 distinct colors.

With flag `0` the same windows come back blank (2 colors). So the host uses flag `0x2` and validates the result
is not a single flat color. Top-level windows are 2576x1408 for a maximized 2560x1440 client area, because
Windows 10/11 include an invisible resize border. The host crops to `DWMWA_EXTENDED_FRAME_BOUNDS` so screenshot
pixels match the visible window.

**What the host does when `PrintWindow` returns a flat image.** It does not use Windows.Graphics.Capture (an
earlier version of this note planned to; it was not built). Instead it takes a plain screen copy of the window
rectangle, but only when nothing covers the window (`IsUnobscured`), because a screen copy of a covered window
would capture the wrong application. If the window is covered it returns no image and an error that says so, and
the model falls back to the UI tree. Every window tried here rendered through `PrintWindow`, so neither fallback
was exercised against a real GPU surface that fails; add Windows.Graphics.Capture if one turns up.

## 3. DPI

The original host process was DPI unaware (`GetAwarenessFromDpiAwarenessContext` returned 0 in the spike
process, and the host had no manifest). At 100% scaling UIA rectangles, window rectangles and input
coordinates agree, so the bug is invisible on this machine. On a scaled display they are virtualized and can
disagree. The host now declares PerMonitorV2 in `app.manifest` so all of them are physical pixels, and the API
takes window-relative coordinates plus the scale a screenshot was downsized by. **Not verified:** this machine has
one 2560x1440 display at 100%, so a 125% or 150% display, and mixed-scale multi-monitor, still need a manual pass.

## 4. UI Automation patterns can steal the foreground

Invoking a control through a UIA pattern is meant to be the quiet route, but classic Win32 providers grab the
foreground a few milliseconds after the call returns. Every pattern call therefore runs inside `Guarded()`, which
notes the foreground window before the call, watches briefly for the target's process taking it, and puts the
previous window back. The action's result says when this happened, because the target did flash forward even
though the user's focus was restored. The E2E checks that quiet actions leave the foreground window and the
cursor where they were. (`Guarded()` watches the foreground only; the cursor is not touched by pattern calls.)

## 5. Modifier keys are read when the target processes the key, not when it is sent

A chord sent as one `SendInput` burst (modifiers down, key, modifiers up) lost its modifier in the E2E's WinForms
target, which reads modifier state while handling the key rather than from the event that carried it. The
host now sends the chord in phases (modifiers down, the key, modifiers up) and between phases waits for the
target's input queue to drain (`GetQueueStatus(QS_INPUT)` until empty, plus a short settle) while attached to the
target thread. The same drain runs before the pointer and foreground window are restored, so restoring does not
race the target reading them.

## 6. Taking over from the agent

While real input is in use the host installs low-level mouse and keyboard hooks, and only then. Events the host
injected itself are ignored by their injected flags. A real button press, wheel turn, pointer move of 6 px or
more, or a real non-modifier key down trips the lease: the in-flight action stops with RPC error `-32005`
(`tookOver`), a `takeover` event is raised, and nothing is restored, since the pointer and focus now belong to the
user. The session then pauses until Resume or Stop, and a pause left alone expires after two minutes. The Stop
chord is real input too, so takeover events are ignored for 1.5 s after a stop.

Verified: injected input does not trip the hooks, and a simulated takeover (`simulate_takeover`, available only
with `DEYIN_CU_TEST_HOOKS=1`) aborts the action and leaves the pointer and foreground alone. **Not verified:**
the decision on genuine hardware events is by reading the hook flags, not by a physical test, because no test can
produce non-injected input from here.

## 7. The Stop chord

The bare Escape key used to be registered as a global shortcut while an action was running, which took Esc away
from every other application for that time. It is gone. Stop is now `Ctrl+Alt+Shift+Esc`, registered only while
computer use is active (a pending, running or paused action) and released when it goes idle.

## 8. Chrome 137+ and `--load-extension`

Branded Chrome 137 and later ignores the `--load-extension` command-line flag, so an extension cannot be injected
at launch. The user loads the bundled extension through `chrome://extensions` (Developer mode, Load unpacked),
which Settings → Chrome walks through. The end-to-end script (`scripts/e2e/chrome-extension-e2e.mjs`) loads the
extension into its own throwaway-profile Chrome through the DevTools Extensions domain, which still works when
Chrome is started with `--enable-unsafe-extension-debugging`; it never touches the user's browser.

## 9. Not covered by these spikes

- **The on-screen overlay** was shown on a real Windows desktop with a real Windows Electron 43.8.11
  (`scripts/e2e/run-overlay-e2e.sh`, 11 checks, plus screenshots of the input and paused states). Windows reports the
  border as click-through (`WS_EX_TRANSPARENT | WS_EX_LAYERED`) and the pill as clickable; both as non-activating,
  topmost, untitled tool windows excluded from capture; `WindowFromPoint` goes through the border and lands on the
  pill's Stop button; the agent's window list contains none of them; Stop and Resume reach the app once each; and the
  window that had focus kept it (its text caret was still in place in both loud-state screenshots). The screenshots caught one defect, a clipped pill shadow that drew a
  grey rectangle, which is fixed. Checks were removed one at a time (no click-through, no capture exclusion) to
  confirm the harness fails when it should. **Not verified:** a second display, a scaled display, a full-screen game
  or video (the pill and border are topmost, but exclusive full-screen can sit above them), Windows 10 before 2004
  (capture exclusion falls back to a black box there), and the packaged installer rather than an unpacked Electron.
  The harness has to clear `ELECTRON_RUN_AS_NODE`, which Windows processes started from Cursor or VS Code inherit and
  which turns `electron.exe` into plain Node.
- Chrome Web Store packaging, and stitching of child-frame coordinates in a real page with nested iframes.
- Scrolling a minimized window with the wheel works only through the fallback route.
