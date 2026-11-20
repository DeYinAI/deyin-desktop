// End-to-end check of the Deyin computer-use host on REAL Windows.
//
// Drives the real C# host through the real pipe client (bundled to host.mjs) against a purpose-built WinForms
// fixture that logs every event it receives, so each claim is proven from the target's own point of view:
//   - quiet actions (UI Automation, window messages) do not move the cursor or change the foreground window
//   - real-input actions put the cursor and the foreground window back
//   - window screenshots come from the window itself, not from whatever covers it
//   - coordinates map correctly, including when the screenshot is downscaled
//   - cancel actually stops work, and the host stays usable afterwards
//   - a Chromium window exposes its page through the accessibility tree and takes a quiet click
// Drive it with scripts/e2e/run-computer-use-e2e.sh.
//
// It only starts, and kills by pid, its OWN fixture windows and its own throwaway-profile Chrome. It never
// touches a window it did not create (the fixture windows are titled "DeyinE2E ...").
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostCancelledError, HostRpcError, PipeComputerUseHost } from "./host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HOST_EXE = process.env.CU_HOST_EXE ?? "C:\\tmp\\deyin-cuh\\bin\\Release\\net8.0-windows\\win-x64\\deyin-computer-use-host.exe";
const APP_EXE = process.env.CU_APP_EXE ?? "C:\\tmp\\deyin-testapp\\bin\\Release\\net8.0-windows\\DeyinTestApp.exe";
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const work = join(here, "work");
const shots = join(work, "shots");
const results = [];
const children = [];

let buffer = null;
function record({ name, ok, detail }) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${String(detail).split("\n").join("\n      ")}`}`);
}
function check(name, ok, detail = "") {
  (buffer ? { push: (c) => buffer.push(c) } : { push: record }).push({ name, ok: Boolean(ok), detail });
}

/**
 * Run a step that measures the real pointer and foreground window. A person using the machine at that instant
 * looks exactly like a failure and is random; a defect in the host fails every time. So a step is retried, and
 * only counts as failed when every attempt fails.
 */
async function step(label, fn, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    buffer = [];
    let error = null;
    try {
      await fn(attempt);
    } catch (e) {
      error = e;
    }
    const mine = buffer;
    buffer = null;
    if (error) mine.push({ name: `${label} completes`, ok: false, detail: error.stack ?? String(error) });
    const failed = mine.filter((c) => !c.ok);
    if (!failed.length || attempt === tries) {
      if (attempt > 1 && !failed.length) console.log(`      (${label}: passed on attempt ${attempt}; earlier attempts were disturbed)`);
      for (const c of mine) record(c);
      return;
    }
    console.log(`      (${label}: attempt ${attempt} failed "${failed[0].name}": ${String(failed[0].detail).split("\n")[0]}; retrying)`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await sleep(100);
  }
}

/* Fixture windows ---------------------------------------------------------------- */

function readLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(l.indexOf("\t") + 1));
}

function startApp(title, { pos = "100,100", size } = {}) {
  const log = join(work, `${title.replace(/\W+/g, "-")}.log`);
  rmSync(log, { force: true });
  const cmd = join(work, `${title.replace(/\W+/g, "-")}.cmd`);
  rmSync(cmd, { force: true });
  const args = ["--title", title, "--log", log, "--pos", pos, "--cmd", cmd];
  if (size) args.push("--size", size);
  const child = spawn(APP_EXE, args, { stdio: "ignore" });
  children.push(child);
  return { title, log, child, lines: () => readLog(log), cmd };
}

/** Wait for a log line matching `pred`, looking only at lines after `from`. */
async function waitLine(app, pred, label, from = 0, timeoutMs = 8000) {
  let found;
  await until(() => {
    found = app.lines().slice(from).find(pred);
    return found !== undefined;
  }, label, timeoutMs);
  return found;
}

let host;
async function findWindow(title, contains = false) {
  return until(
    async () => (await host.listWindows()).find((w) => (contains ? w.title.includes(title) : w.title === title)),
    `window "${title}"`,
    20000,
  );
}

const node = (state, role, name) => state.tree?.nodes.find((n) => n.role === role && n.name === name);
const center = (n) => ({ x: Math.round(n.bounds.x + n.bounds.width / 2), y: Math.round(n.bounds.y + n.bounds.height / 2) });
const pngSize = (file) => {
  const b = readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
};
const sha = (file) => createHash("sha1").update(readFileSync(file)).digest("hex");
const outline = (state) =>
  (state.tree?.nodes ?? []).map((n) => `${"  ".repeat(n.depth)}${n.ref} ${n.role} "${n.name}"${n.value ? ` = "${n.value}"` : ""}`).join("\n");

/**
 * The harness drives the real mouse and keyboard, so a person using the machine at the same moment looks exactly
 * like a failure ("the cursor moved"). Wait until the pointer has been still for a moment before each step.
 */
let interference = 0;
async function idle(stillMs = 900, maxMs = 25000) {
  const end = Date.now() + maxMs;
  let last = (await host.info()).cursor;
  let since = Date.now();
  while (Date.now() < end) {
    await sleep(100);
    const now = (await host.info()).cursor;
    if (now.x !== last.x || now.y !== last.y) {
      last = now;
      since = Date.now();
      interference++;
    } else if (Date.now() - since >= stillMs) {
      return;
    }
  }
}

/**
 * Make the window the foreground window, the way a user would. The fixture does it itself: a real click through
 * the host would not do, because the host puts the previous foreground window back afterwards.
 */
async function front(app, win) {
  await idle();
  writeFileSync(app.cmd, "front");
  await until(async () => (await host.info()).foreground === win.id, `foreground ${win.title}`, 5000);
  await sleep(150);
}

async function main() {
  mkdirSync(shots, { recursive: true });
  process.env.DEYIN_CU_TEST_HOOKS = "1"; // lets the host accept simulate_takeover
  host = new PipeComputerUseHost({ hostExe: HOST_EXE, shotsDir: shots, logPath: join(work, "host.log") });

  /* ---- Host basics ---------------------------------------------------------------- */
  const info = await host.info();
  check("host answers ping with version 2", info.ok && info.version === 2, JSON.stringify(info));
  check("host runs PerMonitorV2 DPI aware (coordinates are physical pixels)", info.dpiAwareness === "per-monitor-v2", info.dpiAwareness);
  check("host is not elevated (ordinary input can reach ordinary apps)", info.elevated === false);
  const displays = await host.listDisplays();
  check("displays are listed with bounds and scale", displays.length >= 1 && displays.every((d) => d.width > 0 && d.scale >= 1), JSON.stringify(displays));
  console.log(`      (${displays.length} display(s): ${displays.map((d) => `${d.width}x${d.height}@${Math.round(d.scale * 100)}%`).join(", ")})`);

  /* ---- Fixture windows: a target, and a decoy exactly on top of it ----------------- */
  const target = startApp("DeyinE2E Target");
  await waitLine(target, (l) => l.startsWith("ready"), "target ready");
  const decoy = startApp("DeyinE2E Decoy");
  await waitLine(decoy, (l) => l.startsWith("ready"), "decoy ready");
  const targetWin = await findWindow("DeyinE2E Target");
  const decoyWin = await findWindow("DeyinE2E Decoy");
  check(
    "window info carries bounds, display and scale",
    targetWin.bounds.width > 400 && targetWin.displayId && targetWin.dpiScale >= 1 && targetWin.pid > 0,
    JSON.stringify(targetWin),
  );
  const one = await host.getWindow(targetWin.id);
  check("get_window returns one window by id", one.id === targetWin.id && one.title === targetWin.title);

  /* ---- Observation ------------------------------------------------------------------ */
  const state = await host.getWindowState(targetWin.id);
  const names = ["Click me", "Check me", "Option A", "Open dialog"].map((n) => state.tree.nodes.find((x) => x.name === n));
  check("accessibility tree lists the fixture's controls with refs", names.every(Boolean) && names.every((n) => /^s\d+e\d+$/.test(n.ref)), outline(state));
  check("tree reports its observation id and size", state.tree.stateId >= 1 && state.tree.visited >= state.tree.nodes.length);
  const shot = state.screenshot;
  const size = shot?.path ? pngSize(shot.path) : null;
  check(
    "screenshot is a PNG whose size matches what the host reports",
    size && size.width === shot.width && size.height === shot.height && size.bytes > 3000,
    JSON.stringify({ shot, size }),
  );
  check(
    "node bounds are in screenshot pixels (the root may include the invisible resize border)",
    state.tree.nodes.every((n) => n.bounds.x >= -12 && n.bounds.y >= -12 && n.bounds.x + n.bounds.width <= shot.width + 12 && n.bounds.y + n.bounds.height <= shot.height + 12),
  );

  /* ---- Capture of a covered window ----------------------------------------------------- */
  // The decoy sits exactly over the target. A screen grab would photograph the decoy for both.
  const decoyState = await host.getWindowState(decoyWin.id, { tree: false });
  const targetState = await host.getWindowState(targetWin.id, { tree: false });
  check(
    "covered window is captured from the window itself, not from what covers it",
    targetState.screenshot?.path && decoyState.screenshot?.path && sha(targetState.screenshot.path) !== sha(decoyState.screenshot.path),
    JSON.stringify({ t: targetState.screenshot, d: decoyState.screenshot }),
  );
  check("capture method is PrintWindow", targetState.screenshot?.method === "printwindow", targetState.screenshot?.method);

  /* ---- Quiet actions ---------------------------------------------------------------------------------- */
  const fresh = () => host.getWindowState(targetWin.id, { screenshot: false });
  const quiet = (label, make, { method = "msg" } = {}) =>
    step(label, async (attempt) => {
      await front(decoy, decoyWin);
      const before = await host.info();
      const mark = target.lines().length;
      const { run, expect } = make(attempt);
      const result = await run();
      const line = await waitLine(target, expect, `${label}: target log`, mark).catch(() => null);
      // Apps that grab the foreground do it a few milliseconds AFTER the call returns, so measure after they had time to.
      await sleep(350);
      const after = await host.info();
      const events = target.lines().slice(mark);
      check(`${label} reaches the app`, line !== null, `result=${JSON.stringify(result)}\nlog=${events.join(" | ")}`);
      check(`${label} goes through ${method}`, result.method === method, JSON.stringify(result));
      check(
        `${label} leaves the cursor alone`,
        before.cursor.x === after.cursor.x && before.cursor.y === after.cursor.y && result.cursorMoved !== true,
        `${JSON.stringify(before.cursor)} -> ${JSON.stringify(after.cursor)}`,
      );
      check(
        `${label} leaves the foreground window alone`,
        before.foreground === decoyWin.id && after.foreground === decoyWin.id && result.focusChanged !== true,
        `fg ${before.foreground} -> ${after.foreground} (decoy ${decoyWin.id}); ${JSON.stringify(result)}`,
      );
    });

  await quiet("click a button by ref", () => ({
    run: async () => host.click(targetWin.id, { ref: node(await fresh(), "Button", "Click me").ref }),
    expect: (l) => /^click:btnClick:\d+$/.test(l),
  }));
  await quiet("toggle a checkbox by ref", () => ({
    run: async () => host.click(targetWin.id, { ref: node(await fresh(), "CheckBox", "Check me").ref }),
    expect: (l) => /^toggle:chkCheck:(True|False)$/.test(l),
  }));
  await quiet("select a radio button by ref", (attempt) => {
    const which = attempt % 2 === 1 ? "B" : "A"; // a retry must pick the one that is not already selected
    return {
      run: async () => host.click(targetWin.id, { ref: node(await fresh(), "RadioButton", `Option ${which}`).ref }),
      expect: (l) => l === `radio:rad${which}`,
    };
  });
  await quiet("set a text field's value by ref", (attempt) => ({
    run: async () => {
      const input = (await fresh()).tree.nodes.find((n) => n.role === "Edit" && n.name === "Input field");
      return host.setValue(targetWin.id, input.ref, `set-by-msg-${attempt}`);
    },
    expect: (l) => l === `text:txtInput:set-by-msg-${attempt}`,
  }));
  const typed = "héllo ✓ wörld\nline2";
  await quiet("type into a classic text control by ref (window messages)", (attempt) => ({
    run: async () => {
      const notes = (await fresh()).tree.nodes.find((n) => n.role === "Edit" && n.name === "Notes");
      return host.typeText(targetWin.id, typed, { ref: notes.ref });
    },
    // The first attempt starts from an empty box, so the exact text is checkable; a retry appends.
    expect: (l) => (attempt === 1 ? l === "text:txtNotes:héllo ✓ wörld\\r\\nline2" : l.startsWith("text:txtNotes:") && l.endsWith("line2")),
  }));
  await quiet("click a classic button by position (posted message)", () => ({
    run: async () => host.click(targetWin.id, { ...center(node(await fresh(), "Button", "Click me")), method: "msg" }),
    expect: (l) => /^click:btnClick:\d+$/.test(l),
  }));

  // Asking for UI Automation explicitly: classic controls make the app take the foreground, and the host puts it back.
  let uiaDetail = "";
  await step("an explicit UI Automation click", async () => {
    await front(decoy, decoyWin);
    const uiaMark = target.lines().length;
    const uia = await host.click(targetWin.id, { ref: node(await fresh(), "Button", "Click me").ref, method: "uia" });
    await waitLine(target, (l) => /^click:btnClick:\d+$/.test(l), "explicit UIA click", uiaMark).catch(() => null);
    await sleep(350);
    const uiaAfter = await host.info();
    uiaDetail = `${uia.detail}; focusChanged=${uia.focusChanged}`;
    check("an explicit UI Automation click works", uia.method === "uia" && target.lines().slice(uiaMark).some((l) => /^click:btnClick:\d+$/.test(l)), JSON.stringify(uia));
    check(
      "when the app grabs the foreground after a UI Automation action, the previous window is put back and the result says so",
      uiaAfter.foreground === decoyWin.id,
      `fg=${uiaAfter.foreground} decoy=${decoyWin.id} ${JSON.stringify(uia)}`,
    );
  });
  console.log(`      (explicit UIA click: ${uiaDetail})`);

  // Scrolling a list through its accessibility pattern.
  let st = await fresh();
  const hasList = st.tree.nodes.some((n) => n.name === "Items" && (n.role === "List" || n.role === "Pane"));
  check("a scrollable list is in the tree", hasList, outline(st));
  if (hasList) {
    let scrollDetail = "";
    await step("scrolling a list", async () => {
      await front(decoy, decoyWin);
      const list = (await fresh()).tree.nodes.find((n) => n.name === "Items" && (n.role === "List" || n.role === "Pane"));
      const beforeScroll = await host.info();
      const mark = target.lines().length;
      const scrolled = await host.scroll(targetWin.id, { ref: list.ref, deltaY: 400 });
      const top = await waitLine(target, (l) => l.startsWith("top:lstItems:"), "list scrolled", mark).catch(() => null);
      await sleep(350);
      const afterScroll = await host.info();
      scrollDetail = `${scrolled.method}: ${scrolled.detail ?? ""}`;
      check("scrolling a list moves it", top !== null, `result=${JSON.stringify(scrolled)}`);
      check(
        "scrolling a list puts the cursor and foreground back",
        beforeScroll.cursor.x === afterScroll.cursor.x && beforeScroll.cursor.y === afterScroll.cursor.y && afterScroll.foreground === decoyWin.id,
        `${JSON.stringify(beforeScroll.cursor)} -> ${JSON.stringify(afterScroll.cursor)}; fg=${afterScroll.foreground}`,
      );
    });
    console.log(`      (scroll went through ${scrollDetail})`);
  }

  /* ---- Stale refs and bad input -------------------------------------------------------- */
  const old = node(st, "Button", "Click me").ref;
  await host.getWindowState(targetWin.id, { screenshot: false }); // a newer observation
  const stale = await host.click(targetWin.id, { ref: old }).then(() => null, (e) => e.message);
  check("a ref from an older observation is refused, not guessed at", stale && /observation|expired|older|latest/i.test(stale), stale);
  const bad = await host.click(targetWin.id, { ref: "banana" }).then(() => null, (e) => e.message);
  check("a malformed ref gets a clear error", bad && /not a valid ref/i.test(bad), bad);
  const outside = await host.click(targetWin.id, { x: 99999, y: 5 }).then(() => null, (e) => e.message);
  check("a point outside the window is rejected with the valid range", outside && /outside the window/i.test(outside), outside);
  const missing = await host.click("123456789", { x: 1, y: 1 }).then(() => null, (e) => e.message);
  check("an unknown window gets a clear error", missing && /not found|closed/i.test(missing), missing);

  /* ---- Real input restores what it touches ------------------------------------------------ */
  st = await fresh();
  const surface = st.tree.nodes.find((n) => n.name === "Surface");
  check("fixture surface is in the tree", Boolean(surface), outline(st));
  const sc = center(surface);

  /** One real-input step: front the decoy, act, then check the target saw it and the pointer and foreground came back. */
  const real = (label, run, expectLine, extra) =>
    step(label, async () => {
      await front(decoy, decoyWin);
      const before = await host.info();
      const mark = target.lines().length;
      const result = await run();
      const line = await waitLine(target, expectLine, `${label}: target log`, mark).catch(() => null);
      await sleep(250);
      const after = await host.info();
      check(`${label} reaches the app`, line !== null, `result=${JSON.stringify(result)}\nlog=${target.lines().slice(mark).join(" | ")}`);
      check(`${label} is reported as real input`, result.method === "input", JSON.stringify(result));
      check(`${label} puts the cursor back`, before.cursor.x === after.cursor.x && before.cursor.y === after.cursor.y, `${JSON.stringify(before.cursor)} -> ${JSON.stringify(after.cursor)}`);
      check(`${label} puts the previous foreground window back`, after.foreground === decoyWin.id, `fg=${after.foreground} decoy=${decoyWin.id}`);
      extra?.({ result, mark });
    });

  await real(
    "click at a point",
    () => host.click(targetWin.id, { ...sc, method: "input" }),
    (l) => l.startsWith("mouseup:pnlSurface:Left"),
    ({ result, mark }) => {
      const down = target.lines().slice(mark).find((l) => l.startsWith("mousedown:pnlSurface:Left"));
      const m = /@(\d+),(\d+) size=(\d+)x(\d+)/.exec(down ?? "");
      check(
        "the click lands on the pixel that was asked for",
        m && Math.abs(Number(m[1]) - Number(m[3]) / 2) <= 3 && Math.abs(Number(m[2]) - Number(m[4]) / 2) <= 3,
        `${down}  (wanted the centre)`,
      );
      check("the click reports it moved the cursor and focus", result.cursorMoved === true && result.focusChanged === true, JSON.stringify(result));
    },
  );
  await real(
    "right-click",
    () => host.click(targetWin.id, { ...sc, button: "right", method: "input" }),
    (l) => l.startsWith("mouseup:pnlSurface:Right"),
    ({ mark }) => check("right-click used the right button", target.lines().slice(mark).some((l) => l.startsWith("mousedown:pnlSurface:Right"))),
  );
  await real("double-click", () => host.click(targetWin.id, { ...sc, count: 2, method: "input" }), (l) => l.startsWith("dblclick:pnlSurface:Left"));
  await real(
    "drag",
    () => host.drag(targetWin.id, { x: sc.x - 50, y: sc.y }, { x: sc.x + 50, y: sc.y + 12 }),
    (l) => l.startsWith("drag:pnlSurface:"),
    ({ mark }) => {
      const dragLine = target.lines().slice(mark).find((l) => l.startsWith("drag:pnlSurface:")) ?? "";
      const dm = /(\d+),(\d+)->(\d+),(\d+)/.exec(dragLine);
      check("drag travels the requested distance", dm && Math.abs(Number(dm[3]) - Number(dm[1]) - 100) <= 4 && Math.abs(Number(dm[4]) - Number(dm[2]) - 12) <= 4, dragLine);
    },
  );

  await step("hover", async () => {
    await front(decoy, decoyWin);
    await host.hover(targetWin.id, { x: 12, y: 12 }); // start outside the surface so entering it is an event
    const mark = target.lines().length;
    const hover = await host.hover(targetWin.id, sc);
    const entered = await waitLine(target, (l) => l === "hover:pnlSurface", "hover reaches the app", mark).catch(() => null);
    check("hover reaches the app", entered !== null, JSON.stringify(hover));
    const cursorNow = (await host.info()).cursor;
    const win = await host.getWindow(targetWin.id);
    const wantX = win.bounds.x + sc.x;
    const wantY = win.bounds.y + sc.y;
    check("hover leaves the cursor where it hovered", Math.abs(cursorNow.x - wantX) <= 2 && Math.abs(cursorNow.y - wantY) <= 2, `cursor=${JSON.stringify(cursorNow)} want=${wantX},${wantY}`);
  });

  await step("a key chord", async () => {
    await front(decoy, decoyWin);
    const keyMark = target.lines().length;
    const key = await host.pressKey(targetWin.id, "ctrl+shift+x");
    const keyLine = await waitLine(target, (l) => l.startsWith("key:") && l.includes("X"), "key reaches the app", keyMark).catch(() => null);
    check("a key chord reaches the app with its modifiers", keyLine && /Control/.test(keyLine) && /Shift/.test(keyLine) && /X/.test(keyLine), `${keyLine} ${JSON.stringify(key)}`);
    check("a key chord is reported as real input", key.method === "input");
    await sleep(250);
    check("a key chord puts the previous foreground window back", (await host.info()).foreground === decoyWin.id);
  });

  /* ---- Real input announces itself, and yields to the user ----------------------------------------- */
  const events = [];
  host.onEvent((e) => events.push({ ...e, at: Date.now() }));
  await step("raw input announces itself", async () => {
    await front(decoy, decoyWin);
    events.length = 0;
    st = await host.getWindowState(targetWin.id, { screenshot: false });
    const button = node(st, "Button", "Click me");
    const bounds = (await host.getWindow(targetWin.id)).bounds;
    const startedAt = Date.now();
    const res = await host.click(targetWin.id, { ref: button.ref, method: "input" });
    const took = Date.now() - startedAt;
    await sleep(300);
    const inputs = events.filter((e) => e.type === "input");
    const on = inputs.find((e) => e.data?.active === true);
    const off = inputs.find((e) => e.data?.active === false);
    check("raw input raises an event with the point it is about to act on", Boolean(on) && typeof on.data.x === "number" && on.data.x >= bounds.x && on.data.x <= bounds.x + bounds.width, JSON.stringify(inputs));
    check("raw input raises an event when it is finished", Boolean(off) && off.at >= on.at, JSON.stringify(inputs));
    check("the on-screen cue gets a moment before the first real input", took >= 140, `${took}ms ${JSON.stringify(res)}`);
    check("host's own injected input does not count as the user taking over", res.ok && !events.some((e) => e.type === "takeover"), JSON.stringify(events));
  });

  await step("a quiet action does not raise the input cue", async () => {
    events.length = 0;
    st = await host.getWindowState(targetWin.id, { screenshot: false });
    await host.click(targetWin.id, { ref: node(st, "Button", "Click me").ref });
    await sleep(200);
    check("quiet actions never claim to be using the real mouse", !events.some((e) => e.type === "input"), JSON.stringify(events));
  });

  await step("the user taking over stops real input and leaves things alone", async () => {
    await front(decoy, decoyWin);
    events.length = 0;
    st = await host.getWindowState(targetWin.id, { screenshot: false });
    const notes = st.tree.nodes.find((n) => n.role === "Edit" && n.name === "Notes");
    const typing = host.typeText(targetWin.id, "z".repeat(400_000), { method: "input" });
    const outcome = typing.then(
      () => ({ kind: "finished" }),
      (e) => ({ kind: e instanceof HostRpcError ? `rpc ${e.code}` : `error ${e.message}`, message: e.message }),
    );
    await until(() => events.some((e) => e.type === "input" && e.data?.active === true), "typing started", 8000);
    await sleep(250);
    const tripped = await host.simulateTakeover();
    const result = await outcome;
    check("the test hook reached the running action", tripped.tripped >= 1, JSON.stringify(tripped));
    check("a takeover fails the action with the takeover code", result.kind === `rpc ${-32005}`, JSON.stringify(result));
    check("a takeover is announced as an event", events.some((e) => e.type === "takeover"), JSON.stringify(events.map((e) => e.type)));
    await sleep(500);
    check("after a takeover nothing is put back (the pointer and focus are the user's)", (await host.info()).foreground === targetWin.id, `foreground=${(await host.info()).foreground}`);
    check("the host takes new work after a takeover", (await host.ping()) && (await host.getWindow(targetWin.id)).id === targetWin.id);
    void notes;
    // let the fixture finish what was already queued so later checks are not polluted
    await until(async () => {
      const a = target.lines().length;
      await sleep(700);
      return target.lines().length === a;
    }, "fixture drained", 60000).catch(() => undefined);
  });

  /* ---- Modal dialogs ----------------------------------------------------------------------------- */
  // Invoke on a button that opens a modal dialog can block until the dialog closes. Asking for UI Automation
  // explicitly must still return, and leave the host usable.
  await front(decoy, decoyWin);
  st = await host.getWindowState(targetWin.id, { screenshot: false });
  const dlgMark = target.lines().length;
  const started = Date.now();
  const dlg = await host.click(targetWin.id, { ref: node(st, "Button", "Open dialog").ref, method: "uia" });
  const elapsed = Date.now() - started;
  await waitLine(target, (l) => l === "dialog:open", "dialog opened", dlgMark);
  check("a UI Automation click that opens a modal dialog returns promptly instead of hanging", elapsed < 6000, `${elapsed}ms ${JSON.stringify(dlg)}`);
  check("host stays responsive while a dialog is open", await host.ping());
  // A person sees the dialog as a new window and works with it.
  const dialogWin = await findWindow("Test dialog");
  check("a modal dialog appears as its own window", Boolean(dialogWin) && dialogWin.pid === targetWin.pid, JSON.stringify(dialogWin));
  // While the UI Automation call that opened the dialog is still in flight, the app answers no accessibility
  // requests. The host must say so quickly and still return the picture, so the dialog can be seen and dismissed.
  const askedAt = Date.now();
  const dialogState = await host.getWindowState(dialogWin.id);
  check(
    "while the app is stuck in a dialog the host returns the screenshot and says why there is no tree",
    Boolean(dialogState.screenshot?.path) && (dialogState.tree || /not answering|modal/i.test(dialogState.treeError ?? "")) && Date.now() - askedAt < 16000,
    `${Date.now() - askedAt}ms ${JSON.stringify({ tree: Boolean(dialogState.tree), err: dialogState.treeError })}`,
  );
  await host.pressKey(dialogWin.id, "Enter");
  await waitLine(target, (l) => l === "dialog:closed", "dialog closed by Enter", dlgMark).then(
    () => check("the dialog can be dismissed with a key", true),
    () => check("the dialog can be dismissed with a key", false, target.lines().slice(dlgMark).join(" | ")),
  );

  // The quiet way: open it with a posted click, close it by clicking OK.
  await front(decoy, decoyWin);
  st = await host.getWindowState(targetWin.id, { screenshot: false });
  const dlg2Mark = target.lines().length;
  const open2 = await host.click(targetWin.id, { ref: node(st, "Button", "Open dialog").ref });
  await waitLine(target, (l) => l === "dialog:open", "second dialog opened", dlg2Mark);
  const dialog2 = await findWindow("Test dialog");
  const dialog2State = await host.getWindowState(dialog2.id, { screenshot: false });
  const okButton = dialog2State.tree.nodes.find((n) => n.role === "Button" && n.name === "OK");
  const close = await host.click(dialog2.id, { ref: okButton.ref });
  await waitLine(target, (l) => l === "dialog:closed", "second dialog closed", dlg2Mark).then(
    () => check("a dialog opens and closes through quiet clicks", open2.method === "msg" && close.method === "msg", `${JSON.stringify(open2)} ${JSON.stringify(close)}`),
    () => check("a dialog opens and closes through quiet clicks", false, `${JSON.stringify(close)} ${target.lines().slice(dlg2Mark).join(" | ")}`),
  );
  await sleep(300);
  check("quiet dialog handling left the foreground window alone", (await host.info()).foreground === decoyWin.id);

  /* ---- Cancel ----------------------------------------------------------------------------------- */
  st = await host.getWindowState(targetWin.id, { screenshot: false });
  const notes2 = st.tree.nodes.find((n) => n.role === "Edit" && n.name === "Notes");
  const huge = "x".repeat(400_000);
  const ac = new AbortController();
  host.setAbortSignal(ac.signal);
  const typing = host.typeText(targetWin.id, huge, { ref: notes2.ref });
  setTimeout(() => ac.abort(), 700);
  const outcome = await typing.then(() => "finished", (e) => (e instanceof HostCancelledError ? "cancelled" : `error: ${e.message}`));
  host.setAbortSignal(undefined);
  check("cancelling stops a long typing run", outcome === "cancelled", outcome);
  const lenOf = () => {
    const l = [...target.lines()].reverse().find((x) => x.startsWith("text:txtNotes:len="));
    return l ? Number(l.split("len=")[1]) : 0;
  };
  await sleep(600);
  const len1 = lenOf();
  await sleep(1000);
  const len2 = lenOf();
  check("after cancel the app stops receiving characters", len1 > 0 && len1 < huge.length && len1 === len2, `len ${len1} then ${len2} of ${huge.length}`);
  check("the host answers after a cancel", await host.ping());
  const after = await host.getWindowState(targetWin.id, { screenshot: false, tree: false });
  check("the host takes new work after a cancel", after.window.id === targetWin.id);

  /* ---- Screenshot downscale and coordinate mapping -------------------------------------------- */
  const wide = startApp("DeyinE2E Wide", { pos: "0,0", size: "3000,460" });
  await waitLine(wide, (l) => l.startsWith("ready"), "wide ready");
  const wideWin = await findWindow("DeyinE2E Wide");
  const wideState = await host.getWindowState(wideWin.id);
  const ws = wideState.screenshot;
  check(
    "a window wider than the cap is downscaled and says by how much",
    ws && ws.scale < 1 && Math.max(ws.width, ws.height) <= 2560 && Math.abs(ws.scale - 2560 / wideWin.bounds.width) < 0.02,
    JSON.stringify({ ws, bounds: wideWin.bounds }),
  );
  const wideSurface = wideState.tree.nodes.find((n) => n.name === "Surface");
  const wc = center(wideSurface);
  await host.click(wideWin.id, { ...wc, method: "input" });
  const wdown = await waitLine(wide, (l) => l.startsWith("mousedown:pnlSurface:Left"), "wide click").catch(() => "");
  const wm = /@(\d+),(\d+) size=(\d+)x(\d+)/.exec(wdown);
  check(
    "coordinates are converted back correctly when the screenshot is downscaled",
    wm && Math.abs(Number(wm[1]) - Number(wm[3]) / 2) <= 4 && Math.abs(Number(wm[2]) - Number(wm[4]) / 2) <= 4,
    `${wdown}  scale=${ws?.scale}`,
  );

  /* ---- launch_app returns the window it opened ---------------------------------------------------- */
  const launched = await host.launchApp(APP_EXE);
  check("launch_app finds the window it opened", launched.windowId && launched.window?.title === "Deyin Test App", JSON.stringify(launched));
  if (launched.pid) spawnSync("taskkill", ["/PID", String(launched.pid), "/F"]);

  /* ---- Chromium depth ------------------------------------------------------------------------------ */
  await chromiumDepth(decoy, decoyWin);

  host.dispose();
}

async function chromiumDepth(decoy, decoyWin) {
  if (!existsSync(CHROME)) {
    check("Chromium window exposes its page (skipped: Chrome not installed)", true);
    return;
  }
  const profile = join(work, "chrome-profile");
  rmSync(profile, { recursive: true, force: true });
  const page = "<title>ChromiumDepth E2E</title><h1>Order</h1><input aria-label='Name field'><button onclick=\"document.title='ChromiumDepth clicked'\">Submit order</button>";
  const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--new-window", `data:text/html,${encodeURIComponent(page)}`], { stdio: "ignore" });
  children.push(chrome);
  try {
    const win = await findWindow("ChromiumDepth E2E", true);
    // No accessibility flag on purpose: the host's first read is what makes Chromium build its tree.
    const state = await until(
      async () => {
        const s = await host.getWindowState(win.id, { screenshot: false });
        return s.tree.nodes.some((n) => n.name === "Submit order") ? s : null;
      },
      "Chromium page controls in the tree",
      20000,
    ).catch(() => null);
    check("a Chromium window exposes its page controls in the tree", Boolean(state), state ? "" : outline(await host.getWindowState(win.id, { screenshot: false })));
    if (!state) return;
    const button = state.tree.nodes.find((n) => n.name === "Submit order");
    const field = state.tree.nodes.find((n) => n.name === "Name field");
    await front(decoy, decoyWin);
    const result = await host.click(win.id, { ref: button.ref });
    await sleep(350);
    const fgAfter = (await host.info()).foreground;
    const clicked = await until(async () => (await host.listWindows()).find((w) => w.title.includes("ChromiumDepth clicked")), "page reacted to the click", 8000).catch(() => null);
    check("a quiet click works inside a web page", Boolean(clicked) && result.method === "uia", JSON.stringify(result));
    check("a web page click leaves the foreground window alone", fgAfter === decoyWin.id, `fg=${fgAfter} decoy=${decoyWin.id} ${JSON.stringify(result)}`);
    if (field) {
      const set = await host.setValue(win.id, field.ref, "Ada Lovelace");
      const reread = await host.getWindowState(win.id, { screenshot: false, query: "Name field" });
      const value = reread.tree.nodes.find((n) => n.name === "Name field")?.value;
      check("a web page text field takes a value and reports it back", value === "Ada Lovelace", `${JSON.stringify(set)} value=${value}`);
    }
    const filtered = await host.getWindowState(win.id, { screenshot: false, query: "Submit" });
    check("a query returns just the matching elements and their parents", filtered.tree.nodes.length > 0 && filtered.tree.nodes.length < state.tree.nodes.length, `${filtered.tree.nodes.length} of ${state.tree.nodes.length}`);
  } finally {
    spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"]);
  }
}

main()
  .catch((err) => {
    check("end-to-end run completes", false, err?.stack ?? String(err));
  })
  .finally(() => {
    try {
      host?.dispose();
    } catch {
      // already gone
    }
    for (const c of children) {
      if (c.pid) spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"]);
    }
    const failed = results.filter((r) => !r.ok);
    if (interference > 0) console.log(`\n(the pointer moved on its own ${interference} time(s) between steps: someone was using the machine; a failure that shows a small cursor shift is not the host)`);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((f) => f.name).join("; ")}` : ""}`);
    process.exit(failed.length ? 1 : 0);
  });
