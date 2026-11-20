// End-to-end check of the Deyin Chrome module against REAL Chrome on Windows.
//
// Runs the real relay, ChromeControl and chrome_* tools (bundled to host.mjs)
// against the real extension loaded into a throwaway-profile Chrome, then
// checks both that the tools work and that the user's own tabs and focus are
// left alone. Drive it with scripts/e2e/run-chrome-e2e.sh.
//
// It only ever starts and kills ITS OWN Chrome (own --user-data-dir, killed by
// pid). The user's browser is never touched.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { ChromeBridge, ChromeControl, createChromeTools, DEYIN_EXTENSION_ID } from "./host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9341;
const PAGE_PORT = 5199;
const profile = join(here, "profile");
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${String(detail).split("\n").join("\n      ")}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await sleep(150);
  }
}

/* Minimal CDP client ----------------------------------------------------------- */
async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
  let id = 0;
  const waiting = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    const w = m.id && waiting.get(m.id);
    if (w) (waiting.delete(m.id), m.error ? w.rej(new Error(m.error.message)) : w.res(m.result));
  });
  return {
    send: (method, params = {}) => new Promise((res, rej) => (waiting.set(++id, { res, rej }), ws.send(JSON.stringify({ id, method, params })))),
    close: () => ws.close(),
  };
}
async function evalIn(target, expression) {
  const c = await cdp(target.webSocketDebuggerUrl);
  try {
    const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  } finally {
    c.close();
  }
}
const listTargets = async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();

/* Test site -------------------------------------------------------------------- */
const PAGE = `<!doctype html><title>Deyin E2E</title><body>
<h1>Deyin E2E</h1>
<form id="f" onsubmit="event.preventDefault();document.getElementById('out').textContent='submitted:'+document.getElementById('email').value">
  <label>Email <input id="email" type="email"></label> <button>Sign in</button>
</form>
<p id="out"></p>
<div id="dsrc" draggable="true" style="width:80px;height:30px;background:#ccc" ondragstart="event.dataTransfer.setData('text/plain','x')">drag me</div>
<div id="ddst" style="width:120px;height:60px;background:#aaa" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.body.dataset.dnd='dropped'">drop here</div>
<select id="sel"><option value="a">Alpha</option><option value="b">Beta</option></select>
<button id="alertbtn" onclick="alert('hello from page')">Alert</button>
<a id="popup" href="/second" target="_blank">Open second</a>
<div style="height:3000px"></div>
<button id="bottom" onclick="document.title='bottom clicked'">Bottom</button>`;
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(req.url === "/second" ? "<title>Second</title><h1>Second page</h1>" : PAGE);
});

/* Main ------------------------------------------------------------------------- */
let chrome;
const bridgeDir = join(here, "bridge-data");
rmSync(profile, { recursive: true, force: true });
rmSync(bridgeDir, { recursive: true, force: true });
mkdirSync(bridgeDir, { recursive: true });

const bridge = new ChromeBridge({ dataDir: bridgeDir });
const asked = [];
const saved = [];
const control = new ChromeControl({
  bridge,
  approvedOriginsFile: join(bridgeDir, "approved.json"),
  strategy: () => "group",
  requestOriginApproval: async (req) => (asked.push(req), "deny"),
  saveImage: (threadId, image) => (saved.push(image), `shot-${saved.length}.png`),
});
const tools = new Map(createChromeTools(control).map((t) => [t.name, t]));
const T1 = { cwd: "/", todos: [], sessionMeta: { threadId: "e2e-1" } };
const call = (name, args = {}, ctx = T1) => tools.get(name).execute(args, ctx);

try {
  await new Promise((r) => server.listen(PAGE_PORT, "127.0.0.1", r));
  await bridge.start();
  check("relay listens on a loopback port", bridge.snapshot().listening, JSON.stringify(bridge.snapshot()));

  chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      // Branded Chrome 137+ ignores --load-extension; the DevTools Extensions domain still works with this flag.
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      "--window-size=1000,720",
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );
  await until(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.ok).catch(() => false)), "chrome debug port");

  const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  const browser = await cdp(version.webSocketDebuggerUrl);
  const loaded = await browser.send("Extensions.loadUnpacked", { path: join(here, "extension") });
  const extId = loaded.id;
  check("Chrome derives the pinned extension id from the manifest key", extId === DEYIN_EXTENSION_ID, `chrome=${extId} pinned=${DEYIN_EXTENSION_ID}`);
  const sw = await until(async () => (await listTargets()).find((t) => t.type === "service_worker" && t.url.includes(`${extId}/service-worker.js`)), "extension service worker");
  const swEval = (expr) => evalIn(sw, expr);

  /* Pairing ------------------------------------------------------------------- */
  // Rejected while no pairing window is open: the extension must stay disconnected.
  await sleep(2500);
  check("an unpaired browser is not connected while pairing is closed", !bridge.isConnected());

  bridge.beginPairing();
  const code = await until(() => bridge.snapshot().pairingCode, "pairing code from the extension", 30000);
  const popup = await browser.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html`, newWindow: true });
  const popupTarget = await until(async () => (await listTargets()).find((t) => t.id === popup.targetId), "popup target");
  await sleep(500);
  const shown = await evalIn(popupTarget, "document.getElementById('code').textContent");
  check("popup shows the same pairing code as Deyin", shown === code, `popup=${shown} host=${code}`);
  check("Allow is only offered after the code is shown", (await evalIn(popupTarget, "!document.getElementById('pair').hidden")) === true);
  await evalIn(popupTarget, "document.getElementById('allow').click()");
  await until(() => bridge.isConnected(), "connected after Allow");
  check("pairing completes after the user clicks Allow", bridge.snapshot().paired.length === 1);

  /* Isolation baseline --------------------------------------------------------- */
  const userTab = (await swEval("chrome.tabs.query({}).then(ts=>ts.filter(t=>t.url==='about:blank'||t.url===''||t.pendingUrl==='about:blank').map(t=>({id:t.id,windowId:t.windowId})))"))[0];
  await swEval(`chrome.windows.update(${userTab.windowId}, { focused: true })`);
  await sleep(300);
  await swEval(`chrome.tabs.update(${userTab.id}, { active: true })`);
  const before = await swEval("(async()=>{const w=await chrome.windows.getLastFocused();const a=await chrome.tabs.query({active:true,windowId:w.id});return {win:w.id,active:a[0].id,focused:w.focused}})()");

  /* Open and drive a background tab -------------------------------------------- */
  const opened = await call("chrome_open", { url: `http://127.0.0.1:${PAGE_PORT}/` });
  check("chrome_open opens a tab", /^Opened tab \d+/.test(opened), opened);
  const tabId = Number(/tab (\d+)/.exec(opened)?.[1]);
  check("localhost needs no approval", asked.length === 0, JSON.stringify(asked));

  const tabState = await swEval(`(async()=>{const t=await chrome.tabs.get(${tabId});const g=t.groupId>=0?await chrome.tabGroups.get(t.groupId):null;return {active:t.active,group:g&&g.title,groupId:t.groupId}})()`);
  check("agent tab is a background tab (not active)", tabState.active === false, JSON.stringify(tabState));
  check('agent tab sits in a "Deyin" tab group', tabState.group === "Deyin", JSON.stringify(tabState));

  const snap = await call("chrome_snapshot");
  check("snapshot reads the page with refs", /textbox "Email".*\[ref=e\d+\]/.test(snap) && /button "Sign in"/.test(snap) && /link "Open second"/.test(snap), snap);
  const ref = (re) => new RegExp(`${re.source}.*\\[ref=(e\\d+)\\]`).exec(snap)?.[1];
  const emailRef = ref(/textbox "Email"/);
  const signRef = ref(/button "Sign in"/);
  const linkRef = ref(/link "Open second"/);
  const selRef = ref(/combobox/);
  const alertRef = ref(/button "Alert"/);
  const bottomRef = ref(/button "Bottom"/);

  const filled = await call("chrome_fill", { ref: emailRef, value: "me@example.com", submit: true });
  const out1 = await call("chrome_evaluate", { expression: "document.getElementById('out').textContent" });
  check("fill + Enter works in a background tab (trusted key events)", out1 === "submitted:me@example.com", `${filled}\n${out1}`);

  await call("chrome_click", { ref: signRef });
  check("click works in a background tab", !String(await call("chrome_click", { ref: signRef })).startsWith("ERROR"));

  const sel = await call("chrome_select", { ref: selRef, values: ["Beta"] });
  check("select picks by label", /Selected Beta/.test(sel), sel);

  const rect = (id) => `(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`;
  const from = JSON.parse(await call("chrome_evaluate", { expression: rect("dsrc") }));
  const to = JSON.parse(await call("chrome_evaluate", { expression: rect("ddst") }));
  const dragged = await call("chrome_drag", { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y });
  const dnd = await call("chrome_evaluate", { expression: "document.body.dataset.dnd || 'no drop'" });
  check("native HTML5 drag-and-drop works in a background tab", dnd === "dropped" && /native drag-and-drop/.test(dragged), `${dragged}\n${dnd}`);

  await call("chrome_scroll", { delta_y: 1200 });
  const bottomClick = await call("chrome_click", { ref: bottomRef });
  const title = await call("chrome_evaluate", { expression: "document.title" });
  check("scroll + click an element below the fold", title === "bottom clicked", `${bottomClick}\n${title}`);

  const alertOut = await call("chrome_click", { ref: alertRef });
  check("a click that opens a dialog reports it", /dialog is open.*hello from page/s.test(alertOut), alertOut);
  check("snapshot reports the blocking dialog instead of hanging", /blocked by a JavaScript alert dialog/.test(await call("chrome_snapshot")));
  check("dialog can be accepted", /Accepted alert dialog/.test(await call("chrome_dialog", { accept: true })));

  await call("chrome_click", { ref: linkRef });
  await sleep(600);
  const tabsList = await call("chrome_tabs", { action: "list" });
  const rawTabs = await swEval("chrome.tabs.query({}).then(ts=>ts.map(t=>({id:t.id,active:t.active,opener:t.openerTabId,group:t.groupId,win:t.windowId,url:t.url})))");
  check("a target=_blank popup from the agent tab is adopted into the Deyin group", (tabsList.match(/\[deyin\]/g) ?? []).length === 2, `${tabsList}\n${JSON.stringify(rawTabs)}`);

  const shot = await call("chrome_screenshot");
  check("screenshot of a background tab produces an image", /deyin-inline-image/.test(shot) && saved.length === 1 && Buffer.from(saved[0].base64, "base64").subarray(1, 4).toString() === "PNG", shot.slice(0, 200));

  const logs = await call("chrome_logs", { kind: "network" });
  check("network log captured requests", /127\.0\.0\.1:5199/.test(logs), logs);

  /* The user's own browser is untouched ---------------------------------------- */
  const after = await swEval("(async()=>{const w=await chrome.windows.getLastFocused();const a=await chrome.tabs.query({active:true,windowId:w.id});return {win:w.id,active:a[0].id,focused:w.focused}})()");
  check("the user's active tab and focused window did not change", after.active === before.active && after.win === before.win, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  check("the user's own tab was never listed to the agent", !(await call("chrome_tabs", { action: "list" })).includes(`${userTab.id} `), "");

  /* Extension-enforced rules --------------------------------------------------- */
  check("chrome:// pages are refused", /^ERROR: Blocked page type/.test(await call("chrome_open", { url: "chrome://settings" })));
  const notShared = await bridge.request("debugger.attach", { tabId: userTab.id }).then(() => "attached", (e) => e.message);
  check("the extension refuses to attach to a tab that is not shared", /not shared with Deyin/.test(notShared), notShared);
  const cookies = await bridge.request("cdp", { tabId, method: "Network.getAllCookies", params: {} }).then(() => "allowed", (e) => e.message);
  check("the extension refuses non-allowlisted CDP methods (cookies)", /CDP method not allowed/.test(cookies), cookies);
  const external = await call("chrome_open", { url: "https://example.com/" });
  check("an unapproved external origin asks the user first (denied here)", /^ERROR: .*did not allow Deyin to use https:\/\/example\.com/.test(external) && asked.length === 1, `${external}\n${JSON.stringify(asked)}`);

  /* Stop from the extension popup ---------------------------------------------- */
  await evalIn(popupTarget, "document.getElementById('stop').click()");
  await until(() => bridge.isStopped(), "stopped propagated");
  check("Stop in the extension blocks tools", /^ERROR: .*stopped/i.test(await call("chrome_snapshot")));
  const resumeViaHost = await bridge.request("control.resume").then(() => "resumed", (e) => e.message);
  check("the host cannot override an extension-initiated Stop", /Stopped from the extension/.test(resumeViaHost), resumeViaHost);
  await evalIn(popupTarget, "document.getElementById('resume').click()");
  await until(() => !bridge.isStopped(), "resume propagated");
  check("Resume in the popup lets tools work again (re-attaches)", /textbox "Email"/.test(await call("chrome_snapshot")));

  /* Sharing a user tab ---------------------------------------------------------- */
  await browser.send("Target.activateTarget", { targetId: (await listTargets()).find((t) => t.type === "page" && t.url === "about:blank")?.id });
  await swEval(`chrome.tabs.update(${userTab.id}, { url: 'http://127.0.0.1:${PAGE_PORT}/second' })`);
  await sleep(600);
  await swEval(`chrome.windows.update(${userTab.windowId}, { focused: true })`);
  await swEval(`chrome.tabs.update(${userTab.id}, { active: true })`);
  await sleep(300);
  await evalIn(popupTarget, "chrome.runtime.sendMessage({ cmd: 'share-active' })");
  await sleep(500);
  const shared = (await call("chrome_tabs", { action: "list" })).includes(`${userTab.id} [shared]`);
  check("the user can share their active tab from the popup", shared, await call("chrome_tabs", { action: "list" }));
  if (shared) {
    const shot2 = await call("chrome_snapshot", { tab_id: userTab.id }, { ...T1, sessionMeta: { threadId: "e2e-2" } });
    check("another conversation can read a shared tab", /Second page/.test(shot2), shot2);
  }

  /* Disconnect ------------------------------------------------------------------ */
  await control.closeAllAgentTabs();
  const left = await swEval(`chrome.tabs.query({}).then(ts=>ts.map(t=>t.id))`);
  check("closing Deyin tabs removes only agent tabs", left.includes(userTab.id) && !left.includes(tabId), JSON.stringify(left));
  browser.close();
} catch (err) {
  check("harness ran to completion", false, err instanceof Error ? err.stack : String(err));
} finally {
  await control.stop().catch(() => undefined);
  await bridge.stop().catch(() => undefined);
  server.close();
  if (chrome?.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
  await sleep(800);
  rmSync(profile, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
