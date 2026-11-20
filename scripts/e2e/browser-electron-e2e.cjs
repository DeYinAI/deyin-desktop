// End-to-end check of the in-app browser tools against a real Electron <webview>.
// Run through scripts/e2e/run-browser-e2e.sh, which bundles ./service.cjs first.
//
// Everything here uses its own throwaway userData dir and a hidden window; nothing
// touches an installed Deyin app.
const { app, BrowserWindow, webContents } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "deyin-browser-e2e-")));
setTimeout(() => {
  console.log("HARD_TIMEOUT");
  process.exit(2);
}, 90_000);

const { BrowserControlService } = require("./service.cjs");

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title>
<style>
 body{font:14px sans-serif;margin:16px}
 button{display:block;margin:8px 0;padding:8px}
 #hov:hover{background:rgb(0,128,0)}
 #src{width:80px;height:30px;background:#ccc;margin:8px 0}
 #dst{width:120px;height:60px;background:#aaa;margin-bottom:8px}
 #m1{width:80px;height:30px;background:#9cf;margin:8px 0}
 #m2{width:120px;height:60px;background:#fc9;margin-bottom:8px}
 #tall{height:3000px}
</style></head><body>
<h1>Deyin fixture</h1>
<form id="f"><label for="email">Email</label> <input id="email" name="email" type="text">
 <label><input id="agree" type="checkbox"> Agree</label>
 <button id="submit" type="submit">Sign in</button></form>
<button id="hov">Hover me</button>
<button id="alertBtn">Raise alert</button>
<button id="confirmBtn">Raise confirm</button>
<div id="src" draggable="true">drag me</div><div id="dst">drop here</div>
<div id="m1">mouse src</div><div id="m2">mouse dst</div>
<div id="tall"></div>
<script>
const $ = (id) => document.getElementById(id);
window.log = [];
const rec = (n, e) => window.log.push(n + ':' + (e.isTrusted ? 'trusted' : 'synthetic'));
$('f').addEventListener('submit', (e) => { e.preventDefault(); window.submitted = $('email').value; rec('submit', e); });
$('submit').addEventListener('click', (e) => rec('click', e));
$('hov').addEventListener('mouseover', (e) => rec('hover', e));
$('agree').addEventListener('change', (e) => rec('agree', e));
$('email').addEventListener('input', (e) => rec('input', e));
$('alertBtn').onclick = () => { alert('Heads up'); document.title = 'after-alert'; };
$('confirmBtn').onclick = () => { document.title = confirm('Sure?') ? 'confirm-yes' : 'confirm-no'; };
$('src').addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'x'); window.log.push('dragstart'); });
$('dst').addEventListener('dragover', (e) => e.preventDefault());
$('dst').addEventListener('drop', (e) => { e.preventDefault(); window.log.push('drop'); });
$('m1').addEventListener('mousedown', () => window.log.push('m1down'));
$('m2').addEventListener('mouseup', () => window.log.push('m2up'));
console.log('fixture-ready');
console.warn('fixture-warn');
fetch('/missing').catch(() => {});
</script></body></html>`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === undefined ? "" : `\n     ${String(detail).split("\n").join("\n     ")}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url.startsWith("/?")) {
      res.setHeader("content-type", "text/html");
      res.end(FIXTURE);
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  // SHOW=1 maps the window (without activating it): input that needs frames (wheel, IME)
  // behaves differently when the window is hidden, and the app's window is normally visible.
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { webviewTag: true } });
  if (process.env.SHOW === "1") win.showInactive();
  const attached = new Promise((resolve) => win.webContents.once("did-attach-webview", (_e, wc) => resolve(wc.id)));
  await win.loadURL("data:text/html,<webview id=w style='width:900px;height:700px' src='about:blank'></webview>");
  const guestId = await attached;
  const guest = webContents.fromId(guestId);
  // Let the webview's own initial about:blank finish, like a tab the user opened earlier.
  await new Promise((resolve) => (guest.isLoading() ? guest.once("did-stop-loading", resolve) : resolve()));
  // A freshly attached webview is still loading its initial about:blank; the app
  // opens a tab the same way, so leave that load racing the first navigate.

  const saved = [];
  const service = new BrowserControlService(
    () => null,
    () => true,
    (threadId, image) => {
      saved.push({ threadId, bytes: Buffer.from(image.base64, "base64").length });
      return `img-${saved.length}.png`;
    },
  );
  if (process.env.NOTHROTTLE === "1") {
    win.webContents.setBackgroundThrottling(false);
    guest.setBackgroundThrottling(false);
  }
  service.register(guestId);
  service.syncTab(guestId, "about:blank", "");

  const tools = new Map(service.tools().map((t) => [t.name, t]));
  const run = async (name, args = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute(args, { cwd: "/", todos: [], sessionMeta: { threadId: "thread-1" } });
  };
  const page = (expr) => guest.executeJavaScript(expr, true);
  const refOf = (snapshot, pattern) => new RegExp(`${pattern}.*\\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];

  // --- navigate + snapshot ---------------------------------------------------
  const nav = await run("browser_navigate", { url: base });
  check("navigate loads the page", /Loaded .*Fixture/.test(nav), nav);

  const snap = await run("browser_snapshot");
  const emailRef = refOf(snap, 'textbox "Email"');
  const agreeRef = refOf(snap, 'checkbox "Agree"');
  const signInRef = refOf(snap, 'button "Sign in"');
  const hoverRef = refOf(snap, 'button "Hover me"');
  check("snapshot lists the form controls with refs", emailRef && agreeRef && signInRef && hoverRef, snap);
  check("snapshot does not mutate the page", (await page("document.querySelectorAll('[data-deyin-ref],[data-ref]').length")) === 0);

  // --- trusted input ------------------------------------------------------------
  const filled = await run("browser_fill", { ref: emailRef, value: "ada@example.com" });
  check(
    "fill by ref sets the value",
    /Filled/.test(filled) && (await page("document.getElementById('email').value")) === "ada@example.com",
    `${filled} | value=${JSON.stringify(await page("document.getElementById('email').value"))} active=${await page("document.activeElement && document.activeElement.id")} hasFocus=${await page("document.hasFocus()")} snapshot-ref=${emailRef}`,
  );
  check("fill produces trusted input events", (await page("window.log")).some((l) => l === "input:trusted"), JSON.stringify(await page("window.log")));

  await run("browser_click", { ref: agreeRef });
  check("click by ref toggles a checkbox with a trusted event", (await page("document.getElementById('agree').checked")) === true && (await page("window.log")).includes("agree:trusted"));

  await run("browser_click", { selector: "#submit" });
  check("click by selector submits the form with a trusted click", (await page("window.submitted")) === "ada@example.com" && (await page("window.log")).includes("click:trusted"), JSON.stringify(await page("window.log")));

  await run("browser_fill", { selector: "#email", value: "" });
  await run("browser_type", { text: "grace", selector: "#email" });
  await run("browser_press", { key: "Enter" });
  await sleep(100);
  check("type then Enter submits", (await page("window.submitted")) === "grace", String(await page("window.submitted")));

  await run("browser_press", { key: "Control+A" });
  await run("browser_type", { text: "X" });
  check("Control+A then typing replaces the selection", (await page("document.getElementById('email').value")) === "X", String(await page("document.getElementById('email').value")));

  const fillForm = await run("browser_fill_form", { fields: [{ selector: "#email", value: "form@example.com" }, { selector: "#nope", value: "x" }] });
  check("fill_form reports hits and misses", /OK #email/.test(fillForm) && /MISS #nope/.test(fillForm) && (await page("document.getElementById('email').value")) === "form@example.com", fillForm);

  const hovered = await run("browser_hover", { ref: hoverRef });
  await sleep(50);
  check("hover triggers :hover and mouseover", /Hovered/.test(hovered) && (await page("getComputedStyle(document.getElementById('hov')).backgroundColor")) === "rgb(0, 128, 0)", hovered);

  const scrolled = await run("browser_scroll", { delta_y: 700 });
  await sleep(600);
  check("scroll moves the page", (await page("window.scrollY")) > 300, `${scrolled} scrollY=${await page("window.scrollY")} viewport=${await page("innerWidth + 'x' + innerHeight")} doc=${await page("document.documentElement.scrollHeight")}`);
  await run("browser_scroll", { delta_y: -2000 });
  await sleep(150);

  // --- drag ---------------------------------------------------------------------------
  await page("window.log.length = 0");
  const drag = await run("browser_drag", { from_selector: "#m1", to_selector: "#m2" });
  check("drag fires real mouse events between elements", (await page("window.log")).includes("m1down") && (await page("window.log")).includes("m2up"), `${drag} ${JSON.stringify(await page("window.log"))}`);

  await page("window.log.length = 0");
  const dnd = await run("browser_drag", { from_selector: "#src", to_selector: "#dst" });
  await sleep(150);
  check("drag drives native HTML5 drag-and-drop", (await page("window.log")).includes("dragstart") && (await page("window.log")).includes("drop"), `${dnd} ${JSON.stringify(await page("window.log"))}`);

  // --- dialogs ------------------------------------------------------------------------------
  const t0 = Date.now();
  const alertClick = await run("browser_click", { selector: "#alertBtn" });
  check("click that opens an alert returns instead of hanging", Date.now() - t0 < 8000 && /alert/i.test(alertClick), `${Date.now() - t0}ms ${alertClick}`);
  const blocked = await run("browser_snapshot");
  check("snapshot while a dialog is open says so", /blocked by a JavaScript alert dialog.*Heads up/s.test(blocked), blocked);
  const accepted = await run("browser_handle_dialog", { accept: true });
  await sleep(150);
  check("handle_dialog accepts the alert and the page continues", /Accepted alert/.test(accepted) && (await page("document.title")) === "after-alert", `${accepted} title=${await page("document.title")}`);

  await run("browser_click", { selector: "#confirmBtn" });
  const dismissed = await run("browser_handle_dialog", { accept: false });
  await sleep(150);
  check("handle_dialog dismisses a confirm", /Dismissed confirm/.test(dismissed) && (await page("document.title")) === "confirm-no", `${dismissed} title=${await page("document.title")}`);
  check("handle_dialog with nothing open is an error result", /^ERROR: No JavaScript dialog is open/.test(await run("browser_handle_dialog", { accept: true })));

  // --- logs, screenshot, errors ----------------------------------------------------------
  const consoleOut = await run("browser_console");
  check("console tail includes load-time output", /fixture-ready/.test(consoleOut) && /fixture-warn/.test(consoleOut), consoleOut);
  const networkOut = await run("browser_network");
  check("network tail shows the 404", /404/.test(networkOut) && /missing/.test(networkOut), networkOut);

  const shot = await run("browser_screenshot");
  check("screenshot saves a file and registers an inline image", /shot-.*\.png/.test(shot) && saved.length === 1 && saved[0].bytes > 1000, `${shot} ${JSON.stringify(saved)}`);

  check("an unknown ref is a readable error naming browser_snapshot", /^ERROR: .*browser_snapshot/s.test(await run("browser_click", { ref: "e999" })));
  check("a bad selector is a readable error", /^ERROR: .*(invalid selector|no element matches)/i.test(await run("browser_click", { selector: "div[[" })), await run("browser_click", { selector: "div[[" }));

  // Refs are cleared by navigation, so a stale one must not click something else.
  const before = refOf(await run("browser_snapshot"), 'button "Sign in"');
  await run("browser_navigate", { url: `${base}?again=1` });
  const stale = await run("browser_click", { ref: before });
  check("refs do not survive a navigation", /^ERROR: /.test(stale), stale);
  const afterSnap = await run("browser_snapshot", { query: "Sign in" });
  check("snapshot query filters to matching elements", /Sign in/.test(afterSnap) && !/Hover me/.test(afterSnap), afterSnap);

  // --- connection refused and tabs ------------------------------------------------------------
  // A port that was just free and is now closed (low ports like 9 are blocked by Chromium as unsafe).
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const closedPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  const refused = await run("browser_navigate", { url: `http://127.0.0.1:${closedPort}/` }).catch((e) => `THROWN ${e.message}`);
  check("connection refused to localhost says to start the dev server", /^ERROR: Connection refused at .*dev server/.test(refused), refused);
  const tabs = await run("browser_tabs", { action: "list" });
  check("tabs list shows the registered tab", /\d/.test(tabs), tabs);

  // A DevTools-style external detach must not strand the tools: the driver is rebuilt.
  await run("browser_navigate", { url: base });
  guest.debugger.detach();
  await sleep(100);
  const rebuilt = await run("browser_snapshot");
  check("tools recover after the debugger was detached", /textbox "Email"/.test(rebuilt), rebuilt);

  server.close();
  win.destroy();
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    check("harness ran to completion", false, err && err.stack ? err.stack : String(err));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
});
