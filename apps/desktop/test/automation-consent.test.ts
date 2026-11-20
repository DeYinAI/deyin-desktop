import assert from "node:assert/strict";
import test from "node:test";
import type { Automation } from "@deyin/host-core";
import {
  automationThreadId,
  browserReadiness,
  checkBrowserCall,
  chromeReadiness,
  consentError,
  consentOrigins,
  isAutomationThread,
  needsChrome,
  normalizeOrigin,
  resourcesOf,
  type BrowserReadiness,
  type ChromeAutomationPort,
} from "../src/main/automations/consent.js";
import { preflight } from "../src/main/automations/health.js";
import { buildRunPrompt } from "../src/main/automations/run-prompt.js";
import { shellInputRefusal } from "../src/main/automations/shell-guard.js";
import { guardToolCall } from "../src/main/automations/tool-guard.js";
import { AUTOMATION_NEVER_SKIP_PREFIXES } from "../src/main/permission-policy.js";

const X = "https://x.com";
const CHATGPT = "https://chatgpt.com";

/* Origins and threads ----------------------------------------------------------------------- */

test("a site is normalized to its origin, and anything that is not a site is refused", () => {
  assert.equal(normalizeOrigin("x.com"), X);
  assert.equal(normalizeOrigin("https://x.com/home?foo=1"), X);
  assert.equal(normalizeOrigin("  https://x.com  "), X);
  assert.equal(normalizeOrigin("http://localhost:3000/app"), "http://localhost:3000");
  assert.equal(normalizeOrigin("localhost:3000"), "https://localhost:3000");
  assert.equal(normalizeOrigin("http://intranet/wiki"), "http://intranet", "a full origin may be a single-label host");
  assert.equal(normalizeOrigin("intranet"), null, "a bare word is a typo, not a site");
  for (const nonsense of ["", "   ", "not a url", "javascript:alert(1)", "about:blank", "file:///etc/passwd"]) {
    assert.equal(normalizeOrigin(nonsense), null, JSON.stringify(nonsense));
  }
  assert.equal(consentError(["x.com", "https://chatgpt.com/c/1"]), null);
  assert.match(consentError(["x.com", "javascript:alert(1)"]) ?? "", /"javascript:alert\(1\)" is not a site/);
  assert.equal(consentError(undefined), null);
});

test("consent is read as normalized, de-duplicated origins; junk entries do not widen it", () => {
  assert.deepEqual(consentOrigins({ consent: { browserOrigins: ["x.com", "https://x.com/home", "nonsense", "https://chatgpt.com"] } }), [X, CHATGPT]);
  assert.deepEqual(consentOrigins({}), []);
});

test("an automation's thread id is recognizable, and never mistaken for a chat's", () => {
  const id = automationThreadId("b814cbbb");
  assert.equal(isAutomationThread(id), true);
  assert.equal(isAutomationThread("thread-1a2b"), false);
  assert.equal(isAutomationThread(undefined), false);
  assert.notEqual(automationThreadId("a"), automationThreadId("b"), "each automation keeps its own tabs");
});

/* The browser guard ------------------------------------------------------------------------- */

test("without consent, Chrome is refused with the instruction to report blocked", () => {
  const verdict = checkBrowserCall("chrome_navigate", { url: `${X}/home` }, []);
  assert.equal(verdict.allow, false);
  assert.match(!verdict.allow ? verdict.reason : "", /no browser consent/);
  assert.match(!verdict.allow ? verdict.reason : "", /approval-required/);
  // Even a call with no URL: acting on whatever tab is open is still acting in the user's browser.
  assert.equal(checkBrowserCall("chrome_click", { selector: "button" }, []).allow, false);
});

test("with consent, a consented site is allowed and any other site is refused with the allowed list", () => {
  assert.equal(checkBrowserCall("chrome_navigate", { url: `${X}/home` }, [X]).allow, true);
  assert.equal(checkBrowserCall("chrome_open", { url: "https://x.com/compose/post" }, [X, CHATGPT]).allow, true);

  const other = checkBrowserCall("chrome_navigate", { url: "https://evil.example/login" }, [X]);
  assert.equal(other.allow, false);
  assert.match(!other.allow ? other.reason : "", /https:\/\/evil\.example is not in this automation's browser consent \(allowed: https:\/\/x\.com\)/);
  assert.match(!other.allow ? other.reason : "", /approval-required/);
});

test("the origin is compared exactly: lookalike hosts, other subdomains, schemes and ports do not pass", () => {
  for (const url of ["https://x.com.evil.example/", "https://evilx.com/", "https://mobile.x.com/", "http://x.com/", "https://x.com:8443/", "https://x.com@evil.example/"]) {
    assert.equal(checkBrowserCall("chrome_navigate", { url }, [X]).allow, false, url);
  }
});

test("a URL is found wherever a tool takes one, including inside a batch", () => {
  const batch = { actions: [{ tool: "chrome_click", selector: "a" }, { tool: "chrome_navigate", url: "https://evil.example/" }] };
  assert.equal(checkBrowserCall("chrome_batch", batch, [X]).allow, false);
  assert.equal(checkBrowserCall("chrome_batch", { actions: [{ url: `${X}/a` }, { url: `${X}/b` }] }, [X]).allow, true);
  assert.equal(checkBrowserCall("chrome_navigate", { url: "not a url" }, [X]).allow, false, "an unparseable url is refused, not skipped");
  assert.equal(checkBrowserCall("chrome_navigate", { url: "javascript:alert(1)" }, [X]).allow, false);
});

test("calls with no URL pass once there is consent; tools that are not browsers are not this guard's business", () => {
  assert.equal(checkBrowserCall("chrome_snapshot", {}, [X]).allow, true);
  assert.equal(checkBrowserCall("chrome_click", { selector: "button" }, [X]).allow, true);
  for (const tool of ["bash", "read", "write", "web_fetch", "automation_report"]) {
    assert.equal(checkBrowserCall(tool, { url: "https://anywhere.example/" }, []).allow, true, tool);
    assert.equal(checkBrowserCall(tool, { url: "https://anywhere.example/" }, [X]).allow, true, tool);
  }
});

test("other browser tools keep working for automations that never mentioned a browser, and are held to consent once they do", () => {
  assert.equal(checkBrowserCall("browser_navigate", { url: "https://example.com" }, []).allow, true);
  assert.equal(checkBrowserCall("browser_navigate", { url: "https://example.com" }, [X]).allow, false);
  assert.equal(checkBrowserCall("browser_navigate", { url: `${X}/home` }, [X]).allow, true);
  assert.equal(checkBrowserCall("mcp__playwright__navigate", { url: "https://example.com" }, [X]).allow, false);
});

test("the guard runs before hooks: it is one call, for browser and shell alike", () => {
  assert.equal(guardToolCall("chrome_navigate", { url: "https://evil.example" }, [X])?.block.includes("not in this automation's browser consent"), true);
  assert.equal(guardToolCall("bash", { command: "powershell -c \"[System.Windows.Forms.SendKeys]::SendWait('hi')\"" }, [X])?.block.includes("type or click"), true);
  assert.equal(guardToolCall("bash", { command: "ls -la" }, [X]), undefined);
  assert.equal(guardToolCall("chrome_navigate", { url: `${X}/home` }, [X]), undefined);
  assert.equal(guardToolCall("bash", {}, []), undefined, "a bash call with no command is not this guard's concern");
});

/* The shell guard --------------------------------------------------------------------------- */

test("a shell command that types or clicks on the screen is refused with what to do instead", () => {
  const synth = [
    `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('hello')"`,
    `powershell "(New-Object -ComObject WScript.Shell).SendKeys('^v')"`,
    `python -c "import pyautogui; pyautogui.click(100, 200)"`,
    `xdotool key ctrl+v`,
    `autohotkey script.ahk`,
    `osascript -e 'tell application "System Events" to keystroke "a"'`,
    `adb shell input tap 10 20`,
    `powershell -c "[user32]::SetCursorPos(10,10)"`,
  ];
  for (const command of synth) {
    const message = shellInputRefusal(command);
    assert.ok(message, command);
    assert.match(message ?? "", /automation_report/);
    assert.match(message ?? "", /tool-missing/);
  }
});

test("ordinary shell work is left alone, including words that merely look similar", () => {
  const fine = [
    "ls -la",
    "git status && git diff",
    "rg postMessage src/",
    "node scripts/build.js",
    "cat posts/log.md | tail -20",
    "curl -s https://api.example.com/v1/models",
    "echo 'send keys later' > notes.txt",
    "python analyze.py --input data.csv",
    "npm run test -- --grep autoclick-config",
  ];
  for (const command of fine) assert.equal(shellInputRefusal(command), null, command);
});

/* Resources --------------------------------------------------------------------------------- */

test("a run that uses the browser holds it alone; one that does not holds nothing", () => {
  assert.deepEqual(resourcesOf({ consent: { browserOrigins: [X] } }), ["browser"]);
  assert.deepEqual(resourcesOf({ requires: { exclusive: ["browser"] } }), ["browser"]);
  assert.deepEqual(resourcesOf({ consent: { browserOrigins: [X] }, requires: { exclusive: ["browser"] } }), ["browser"], "not listed twice");
  assert.deepEqual(resourcesOf({}), []);
  assert.deepEqual(resourcesOf({ consent: { browserOrigins: ["nonsense"] } }), [], "junk consent grants no browser, so holds none");
});

/* Readiness --------------------------------------------------------------------------------- */

const ready: BrowserReadiness = { enabled: true, connection: "connected", stopped: false, approvedOrigins: [X, CHATGPT] };

test("Chrome is ready when it is on, connected, running, and every consented site is approved", () => {
  assert.equal(chromeReadiness([X], ready), null);
  assert.equal(chromeReadiness([X, CHATGPT], ready), null);
});

test("each way Chrome can be unready is a distinct blocker a person can act on", () => {
  assert.deepEqual(chromeReadiness([X], { ...ready, enabled: false })?.kind, "tool-missing");
  assert.match(chromeReadiness([X], { ...ready, enabled: false })?.detail ?? "", /turned off/);
  assert.equal(chromeReadiness([X], { ...ready, stopped: true })?.kind, "stopped");
  for (const connection of ["disconnected", "pairing"] as const) {
    const blocker = chromeReadiness([X], { ...ready, connection });
    assert.equal(blocker?.kind, "tool-missing", connection);
    assert.match(blocker?.detail ?? "", /not connected to Chrome/);
  }
});

test("an unapproved site is named, and a human-only blocker says so", () => {
  const one = chromeReadiness([X, "https://openference.com"], ready);
  assert.equal(one?.kind, "approval-required");
  assert.match(one?.detail ?? "", /^https:\/\/openference\.com is not approved/);
  const two = chromeReadiness([X, "https://a.example", "https://b.example"], ready);
  assert.match(two?.detail ?? "", /https:\/\/a\.example, https:\/\/b\.example are not approved/);
});

test("the Chrome service is read through a narrow port, and a host without Chrome has none", () => {
  const port: ChromeAutomationPort = {
    tools: () => [],
    status: () => ({ enabled: true, connection: "connected", stopped: false }),
    getApprovedOrigins: () => [X],
  };
  assert.deepEqual(browserReadiness(port), { enabled: true, connection: "connected", stopped: false, approvedOrigins: [X] });
  assert.equal(browserReadiness(undefined), undefined);
});

test("only automations that use Chrome are checked for it", () => {
  assert.equal(needsChrome({ consent: { browserOrigins: [X] } }), true);
  assert.equal(needsChrome({ requires: { tools: ["chrome_*"] } }), true);
  assert.equal(needsChrome({ requires: { tools: ["chrome_open"] } }), true);
  assert.equal(needsChrome({ requires: { tools: ["bash"] } }), false);
  assert.equal(needsChrome({}), false);
});

/* Preflight --------------------------------------------------------------------------------- */

const local = { target: { kind: "local" as const, workspacePath: "/w" } };
const probes = (browser?: () => BrowserReadiness | undefined) => ({
  token: async () => "tok",
  workspaceExists: () => true,
  sleep: async () => undefined,
  ...(browser ? { browser } : {}),
});

test("an automation that uses Chrome is blocked before the model when Chrome is not ready, and runs when it is", async () => {
  const consented: Pick<Automation, "target" | "requires" | "consent"> = { ...local, consent: { browserOrigins: [X] } };
  const ok = await preflight(consented, probes(() => ready));
  assert.deepEqual(ok, { ok: true, token: "tok" });

  const off = await preflight(consented, probes(() => ({ ...ready, connection: "disconnected" })));
  assert.equal(!off.ok && off.blocker.kind, "tool-missing");

  const unapproved = await preflight(consented, probes(() => ({ ...ready, approvedOrigins: [] })));
  assert.equal(!unapproved.ok && unapproved.blocker.kind, "approval-required");

  const noChrome = await preflight(consented, probes());
  assert.equal(!noChrome.ok && noChrome.blocker.kind, "tool-missing");
  assert.match(!noChrome.ok ? noChrome.blocker.detail : "", /not available in this app/);
});

test("Chrome is never probed for an automation that does not use it", async () => {
  let asked = 0;
  const result = await preflight(local, probes(() => (asked += 1, undefined)));
  assert.equal(result.ok, true);
  assert.equal(asked, 0);
});

test("Chrome access on a WSL or SSH target is blocked, because those runs cannot reach this machine's browser", async () => {
  const wsl = await preflight({ target: { kind: "wsl", distro: "Ubuntu", workspacePath: "/w" }, consent: { browserOrigins: [X] } }, probes(() => ready));
  assert.equal(!wsl.ok && wsl.blocker.kind, "tool-missing");
  assert.match(!wsl.ok ? wsl.blocker.detail : "", /only works for automations that run on this machine/);
});

/* What the model is told -------------------------------------------------------------------- */

test("the run prompt names the sites and the stop conditions, and says nothing about a browser otherwise", () => {
  const base = { startedAt: 0, limits: { maxMinutes: 15, idleMinutes: 5, maxSteps: 120 } };
  const withBrowser = buildRunPrompt({ ...base, browserOrigins: [X, CHATGPT] });
  assert.match(withBrowser, /## The browser/);
  assert.match(withBrowser, /https:\/\/x\.com, https:\/\/chatgpt\.com/);
  assert.match(withBrowser, /captcha/);
  assert.match(withBrowser, /not with the shell, not with computer_\* tools/);

  assert.equal(buildRunPrompt(base).includes("## The browser"), false);
  assert.equal(buildRunPrompt({ ...base, browserOrigins: [] }).includes("## The browser"), false);
});

/* Policy ------------------------------------------------------------------------------------ */

test("OS input synthesis is still never auto-allowed; Chrome is governed by consent rather than a blanket refusal", () => {
  assert.ok(AUTOMATION_NEVER_SKIP_PREFIXES.includes("computer_"));
  assert.equal(AUTOMATION_NEVER_SKIP_PREFIXES.some((prefix) => "chrome_open".startsWith(prefix)), false);
});
