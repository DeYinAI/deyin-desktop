// End-to-end check of the on-screen computer-use overlay in a real Windows Electron.
// Run through scripts/e2e/run-overlay-e2e.sh, which bundles ./service.cjs and copies this file and the Win32
// probe next to a throwaway Windows Electron.
//
// It shows the real overlay windows on the real desktop for a few seconds, so the border and pill flash on screen.
// Everything runs in its own Electron with a throwaway profile; it never touches an installed Deyin or any other
// window, never moves the pointer (the probe only reads), and the "click" on Stop/Resume is delivered straight to
// the page, not through the mouse.
//
// SHOW_MS=<ms> holds the input and paused states that long for a human or a screenshot; NO_PROTECT=1 turns off
// capture exclusion in this process only so a screenshot can see the overlay.
const { app, BrowserWindow, screen } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SHOW_MS = Number(process.env.SHOW_MS || 0);
const NO_PROTECT = process.env.NO_PROTECT === "1";
const HOST_EXE =
  process.env.CU_HOST_EXE || "C:\\tmp\\deyin-cuh\\bin\\Release\\net8.0-windows\\win-x64\\deyin-computer-use-host.exe";
const LOG = path.join(__dirname, "log.txt");

app.setName("DeyinOverlayE2E");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "deyin-overlay-e2e-"));
app.setPath("userData", profile);
fs.writeFileSync(LOG, "");

const out = (line) => {
  console.log(line);
  fs.appendFileSync(LOG, line + "\n");
};

setTimeout(() => {
  out("HARD_TIMEOUT");
  process.exit(2);
}, 150_000);

// Capture exclusion is part of what is under test, so it is only switched off when asked, for a screenshot.
if (NO_PROTECT) BrowserWindow.prototype.setContentProtection = function () {};

const { ComputerUseOverlay, PipeComputerUseHost } = require("./service.cjs");

const WS_EX_TOPMOST = 0x8;
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_LAYERED = 0x80000;
const WS_EX_NOACTIVATE = 0x08000000;
const has = (value, flag) => (value & flag) === flag;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(describe, fn, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${describe} (last: ${last && last.message ? last.message : JSON.stringify(last)})`);
}

let passed = 0;
let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    out(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    out(`  FAIL ${name}\n       ${err && err.message ? err.message : err}`);
  }
}

const hwndOf = (win) => String(win.getNativeWindowHandle().readBigUInt64LE(0));
const run = (win, js) => win.webContents.executeJavaScript(js, false);

/** The overlay's windows: one pill (420 wide) and one border per display. */
function surfaces() {
  const all = BrowserWindow.getAllWindows();
  const pill = all.find((w) => w.getBounds().width === 420 && w.getBounds().height === 52) || null;
  const borders = all.filter((w) => w !== pill);
  return { all, pill, borders };
}

const borderClass = (win) => run(win, "document.body.className");
const pillLabel = (pill) => run(pill, "document.getElementById('label').textContent");
const pillClass = (pill) => run(pill, "document.getElementById('pill').className");

function probe(windows, points) {
  const file = path.join(profile, "probe.json");
  fs.writeFileSync(file, JSON.stringify({ windows, points }));
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "overlay-win32.ps1"), "-InputFile", file],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw new Error(`probe failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

/** Click a page element the way the user would, but straight into the page (no real mouse). */
async function clickInPage(win, selector) {
  const box = await run(
    win,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`,
  );
  assert.ok(box.w > 0, `${selector} is not visible`);
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  win.webContents.sendInputEvent({ type: "mouseMove", x, y });
  win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  return { x, y };
}

async function main() {
  await app.whenReady();
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const center = screen.dipToScreenPoint({
    x: primary.bounds.x + Math.round(primary.bounds.width / 2),
    y: primary.bounds.y + Math.round(primary.bounds.height / 2),
  });
  out(`displays: ${displays.map((d) => `${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}`).join(", ")}; protection ${NO_PROTECT ? "OFF (screenshot mode)" : "on"}`);

  let enabled = false;
  let stops = 0;
  let resumes = 0;
  const overlay = new ComputerUseOverlay({
    isEnabled: () => enabled,
    onStop: () => {
      stops += 1;
    },
    onResume: () => {
      resumes += 1;
    },
  });

  await step("switched off in settings: nothing is created, whatever the state", async () => {
    overlay.update({ phase: "input", app: "notepad.exe", point: center });
    overlay.update({ phase: "background", app: "notepad.exe" });
    await sleep(300);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
  });

  enabled = true;

  await step("quiet work shows one border per display and the pill, with the border dark", async () => {
    overlay.update({ phase: "background", app: "notepad.exe", action: "click s1e1" });
    await until("windows", () => surfaces().all.length === displays.length + 1);
    const { pill, borders } = surfaces();
    assert.ok(pill, "no pill window");
    assert.equal(borders.length, displays.length);
    await until("pill label", async () => (await pillLabel(pill)) === "Deyin is working in Notepad");
    assert.equal(await pillClass(pill), "background");
    for (const border of borders) assert.equal(await borderClass(border), "", "the border must stay dark during quiet work");
    await until("windows shown", () => surfaces().all.every((w) => w.isVisible()));
  });

  await step("real input lights the border on the display being used, with the loud label and a ripple", async () => {
    overlay.update({ phase: "input", app: "notepad.exe", point: center });
    const { pill, borders } = surfaces();
    await until("pill label", async () => (await pillLabel(pill)) === "Deyin is controlling your computer");
    const lit = [];
    for (const border of borders) lit.push({ display: border.getBounds(), cls: await borderClass(border) });
    const onPrimary = lit.filter((x) => x.cls === "input");
    assert.equal(onPrimary.length, 1, `exactly one border lights up: ${JSON.stringify(lit)}`);
    assert.deepEqual(
      [onPrimary[0].display.x, onPrimary[0].display.y, onPrimary[0].display.width, onPrimary[0].display.height],
      [primary.bounds.x, primary.bounds.y, primary.bounds.width, primary.bounds.height],
    );
    const litBorder = borders.find((b) => b.getBounds().x === primary.bounds.x && b.getBounds().y === primary.bounds.y);
    await until("ripple", async () => (await run(litBorder, "document.querySelectorAll('.ripple').length")) >= 1, 2000);
  });

  await step("the windows are click-through, non-activating, topmost, untitled tool windows, hidden from capture", async () => {
    const { pill, borders } = surfaces();
    const named = [
      ...borders.map((b, i) => ({ name: `border${i}`, win: b })),
      { name: "pill", win: pill },
    ];
    const result = probe(
      named.map((n) => ({ name: n.name, hwnd: hwndOf(n.win) })),
      [],
    );
    for (const w of result.windows) {
      const isPill = w.name === "pill";
      assert.ok(w.visible, `${w.name} is not visible`);
      assert.equal(w.title, "", `${w.name} has a title ("${w.title}"), so the window list could include it`);
      assert.ok(has(w.ex, WS_EX_NOACTIVATE), `${w.name} can take focus (ex=0x${w.ex.toString(16)})`);
      assert.ok(has(w.ex, WS_EX_TOOLWINDOW), `${w.name} is not a tool window (ex=0x${w.ex.toString(16)})`);
      assert.ok(has(w.ex, WS_EX_TOPMOST), `${w.name} is not topmost (ex=0x${w.ex.toString(16)})`);
      if (!NO_PROTECT) assert.notEqual(w.affinity, 0, `${w.name} is not excluded from capture`);
      if (isPill) {
        assert.ok(!has(w.ex, WS_EX_TRANSPARENT), "the pill must be clickable");
      } else {
        assert.ok(has(w.ex, WS_EX_TRANSPARENT) && has(w.ex, WS_EX_LAYERED), `${w.name} is not click-through (ex=0x${w.ex.toString(16)})`);
      }
    }
    // A border covers its whole display exactly.
    const rects = screen.getAllDisplays().map((d) => screen.dipToScreenRect(null, d.bounds));
    for (const w of result.windows.filter((x) => x.name !== "pill")) {
      const match = rects.some((r) => r.x === w.left && r.y === w.top && r.x + r.width === w.right && r.y + r.height === w.bottom);
      assert.ok(match, `${w.name} rect ${w.left},${w.top},${w.right},${w.bottom} matches no display (${JSON.stringify(rects)})`);
    }
  });

  await step("the system hit-tests THROUGH the border but ONTO the pill", async () => {
    const { pill, borders } = surfaces();
    const stopBox = await run(
      pill,
      "(() => { const r = document.getElementById('stop').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()",
    );
    const pillBounds = pill.getContentBounds();
    const stopPoint = screen.dipToScreenPoint({ x: pillBounds.x + Math.round(stopBox.x), y: pillBounds.y + Math.round(stopBox.y) });
    const result = probe([], [
      { name: "screen-center", x: center.x, y: center.y },
      { name: "stop-button", x: stopPoint.x, y: stopPoint.y },
    ]);
    const ours = new Set([hwndOf(pill), ...borders.map(hwndOf)]);
    const centerHit = result.points.find((p) => p.name === "screen-center");
    const stopHit = result.points.find((p) => p.name === "stop-button");
    assert.ok(!ours.has(String(centerHit.root)), `a click in the middle of the screen would land on the overlay (root ${centerHit.root})`);
    assert.equal(String(stopHit.root), hwndOf(pill), `the Stop button is not what the system finds there (root ${stopHit.root})`);
  });

  await step("the agent's own window list never contains an overlay window", async () => {
    const host = new PipeComputerUseHost({ hostExe: HOST_EXE, shotsDir: path.join(profile, "shots"), logPath: path.join(profile, "host.log") });
    try {
      const windows = await host.listWindows();
      assert.ok(windows.length > 0, "the host listed no windows at all, so this check proves nothing");
      const leaked = windows.filter((w) => w.pid === process.pid);
      assert.deepEqual(leaked, [], `overlay windows are listed: ${JSON.stringify(leaked)}`);
    } finally {
      host.dispose();
    }
  });

  await step("a takeover turns the border amber, says so, and offers Resume", async () => {
    overlay.update({ phase: "paused", app: "notepad.exe", point: center });
    const { pill, borders } = surfaces();
    await until("pill label", async () => (await pillLabel(pill)) === "You took over. Resume Deyin?");
    assert.equal(await pillClass(pill), "paused");
    const shown = await run(pill, "getComputedStyle(document.getElementById('resume')).display");
    assert.notEqual(shown, "none", "the Resume button is hidden");
    const classes = [];
    for (const border of borders) classes.push(await borderClass(border));
    assert.equal(classes.filter((c) => c === "paused").length, 1, JSON.stringify(classes));
  });

  await step("Resume and Stop in the pill reach the app, once each", async () => {
    const { pill } = surfaces();
    await clickInPage(pill, "#resume");
    await until("resume", () => resumes === 1);
    await clickInPage(pill, "#stop");
    await until("stop", () => stops === 1);
    await sleep(200);
    assert.deepEqual([resumes, stops], [1, 1]);
  });

  await step("between two actions the border goes at once and the pill lingers, then everything hides", async () => {
    overlay.update({ phase: "input", app: "notepad.exe", point: center });
    await sleep(150);
    overlay.update({ phase: "idle" });
    const { pill, borders } = surfaces();
    await until("borders dark", async () => {
      for (const border of borders) if ((await borderClass(border)) !== "") return false;
      return true;
    });
    assert.ok(pill.isVisible(), "the pill vanished between actions");
    await until("idle label", async () => (await pillLabel(pill)) === "Deyin is working");
    // a new action inside the linger window keeps the same pill
    overlay.update({ phase: "background", app: "notepad.exe" });
    await sleep(4500);
    assert.ok(pill.isVisible(), "the pill went away while an action was running");
    overlay.update({ phase: "idle" });
    await until("everything hidden", () => surfaces().all.every((w) => !w.isVisible()), 7000);
  });

  await step("turning the setting off hides it at once, even mid-action", async () => {
    overlay.update({ phase: "input", app: "notepad.exe", point: center });
    await until("shown", () => surfaces().all.some((w) => w.isVisible()));
    enabled = false;
    overlay.update({ phase: "input", app: "notepad.exe", point: center });
    await until("hidden", () => surfaces().all.every((w) => !w.isVisible()), 2000);
    enabled = true;
  });

  await step("dispose removes every window", async () => {
    overlay.update({ phase: "input", app: "notepad.exe", point: center });
    await until("shown", () => surfaces().all.length > 0);
    overlay.dispose();
    await until("gone", () => BrowserWindow.getAllWindows().length === 0, 2000);
  });

  if (SHOW_MS > 0) {
    const shower = new ComputerUseOverlay({ isEnabled: () => true, onStop: () => {}, onResume: () => {} });
    out(`SHOW input for ${SHOW_MS} ms`);
    shower.update({ phase: "input", app: "notepad.exe", point: center });
    await sleep(SHOW_MS);
    out(`SHOW paused for ${SHOW_MS} ms`);
    shower.update({ phase: "paused", app: "notepad.exe", point: center });
    await sleep(SHOW_MS);
    shower.dispose();
  }

  out(`\n${passed} passed, ${failed} failed`);
  app.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  out(`CRASH ${err && err.stack ? err.stack : err}`);
  app.exit(3);
});

// The overlay windows are the only ones; closing the last one must not quit the app mid-run.
app.on("window-all-closed", () => {});
