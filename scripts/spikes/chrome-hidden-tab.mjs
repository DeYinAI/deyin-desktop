#!/usr/bin/env node
/**
 * Spike: can an agent-owned Chrome tab render, take trusted input and produce
 * screenshots WITHOUT being the visible tab or stealing focus from the user?
 *
 * Mirrors what the Deyin Chrome extension does through chrome.debugger (the CDP
 * domains are identical), so the findings carry over. Run on the machine that
 * has Chrome (Windows):
 *
 *   node scripts/spikes/chrome-hidden-tab.mjs [--chrome "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]
 *
 * It launches Chrome with a throwaway profile on port 9333, runs the matrix,
 * prints JSON, and closes Chrome. Results are recorded in docs/CHROME_SPIKES.md.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9333;
const chromeArg = process.argv.indexOf("--chrome");
const CHROME = chromeArg > 0 ? process.argv[chromeArg + 1] : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const PAGE = `<!doctype html><meta charset=utf-8><title>spike</title>
<body style="margin:0;background:#fff">
<button id=b style="position:fixed;left:40px;top:40px;width:200px;height:60px" onclick="window.__clicks=(window.__clicks||0)+1">click</button>
<canvas id=c width=600 height=400 style="position:fixed;left:40px;top:140px"></canvas>
<script>
  window.__clicks = 0; window.__raf = 0;
  const ctx = document.getElementById("c").getContext("2d");
  const img = ctx.createImageData(600, 400);
  for (let i = 0; i < img.data.length; i++) img.data[i] = (Math.random() * 255) | 0;
  ctx.putImageData(img, 0, 0);
  (function tick() { window.__raf++; requestAnimationFrame(tick); })();
</script>`;
const PAGE_URL = "data:text/html;base64," + Buffer.from(PAGE).toString("base64");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 6000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify(payload));
    });
  }
}

async function waitForChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error("Chrome did not start");
}

async function evalIn(cdp, sessionId, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  return r.result?.value;
}

/** visibilityState, rAF ticks over 600ms, hasFocus. */
async function liveness(cdp, sessionId) {
  const before = await evalIn(cdp, sessionId, "window.__raf");
  await sleep(600);
  const after = await evalIn(cdp, sessionId, "window.__raf");
  return {
    visibility: await evalIn(cdp, sessionId, "document.visibilityState"),
    hasFocus: await evalIn(cdp, sessionId, "document.hasFocus()"),
    rafTicksIn600ms: after - before,
  };
}

async function clickTest(cdp, sessionId) {
  const started = Date.now();
  try {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 70 }, sessionId, 3000);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 70, button: "left", clickCount: 1 }, sessionId, 3000);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 100, y: 70, button: "left", clickCount: 1 }, sessionId, 3000);
  } catch (err) {
    return { ok: false, error: String(err.message), ms: Date.now() - started };
  }
  await sleep(150);
  return { ok: true, clicksRegistered: await evalIn(cdp, sessionId, "window.__clicks"), ms: Date.now() - started };
}

async function shotTest(cdp, sessionId, params = {}) {
  try {
    const r = await cdp.send("Page.captureScreenshot", { format: "png", ...params }, sessionId, 5000);
    return { ok: true, pngBytes: Math.floor((r.data.length * 3) / 4) };
  } catch (err) {
    return { ok: false, error: String(err.message) };
  }
}

async function openTarget(cdp, params) {
  const { targetId } = await cdp.send("Target.createTarget", params);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await sleep(500);
  return { targetId, sessionId };
}

async function matrix(cdp, label, params, userSession) {
  const out = { label };

  // 1. Plain hidden tab, no emulation. Input only: a capture here stalls the
  //    compositor request and poisons later captures on the same tab.
  const plainTab = await openTarget(cdp, params);
  out.userTabAfterOpen = await liveness(cdp, userSession);
  out.plain = { ...(await liveness(cdp, plainTab.sessionId)), click: await clickTest(cdp, plainTab.sessionId) };
  await cdp.send("Target.closeTarget", { targetId: plainTab.targetId });

  // 2. Fresh tab with focus emulation enabled immediately on attach (the order
  //    the extension uses): liveness, trusted input and screenshot.
  const t = await openTarget(cdp, params);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, t.sessionId);
  await sleep(300);
  out.emulationFirst = {
    ...(await liveness(cdp, t.sessionId)),
    click: await clickTest(cdp, t.sessionId),
    screenshot: await shotTest(cdp, t.sessionId),
    screenshotFromSurfaceFalse: await shotTest(cdp, t.sessionId, { fromSurface: false }),
  };
  out.userTabAfterEmulation = await liveness(cdp, userSession);
  await cdp.send("Target.closeTarget", { targetId: t.targetId });
  return out;
}

const profile = mkdtempSync(join(tmpdir(), "deyin-chrome-spike-"));
const chrome = spawn(
  CHROME,
  [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", PAGE_URL],
  { stdio: "ignore", detached: false },
);

try {
  const version = await waitForChrome();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const cdp = new Cdp(ws);

  // The "user's tab" is the page Chrome opened on launch (foreground).
  const { targetInfos } = await cdp.send("Target.getTargets");
  const userTarget = targetInfos.find((t) => t.type === "page");
  const { sessionId: userSession } = await cdp.send("Target.attachToTarget", { targetId: userTarget.targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, userSession);
  await sleep(500);

  const result = {
    chrome: version.Browser,
    userTabBaseline: await liveness(cdp, userSession),
    backgroundTabSameWindow: await matrix(cdp, "background tab, same window", { url: PAGE_URL, background: true }, userSession),
    backgroundSeparateWindow: await matrix(
      cdp,
      "background new window",
      { url: PAGE_URL, background: true, newWindow: true },
      userSession,
    ),
  };
  console.log(JSON.stringify(result, null, 2));
  ws.close();
} finally {
  chrome.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // profile still locked; harmless in tmp
  }
}
