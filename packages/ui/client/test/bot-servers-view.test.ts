import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineHostView, EngineSetupEvent } from "@deyin/host-core/shared";
import { BotPlacementView, type BotPlacementViewProps } from "../src/bots/BotPlacement.js";
import { ServersPanel, type ServersPanelProps } from "../src/bots/ServersPanel.js";
import { placeChoices, reduceSetup, type SetupViews } from "../src/bots/botServers.js";

const noop = () => undefined;
const engine = { port: 7790, version: "1.4.0", supervisor: "systemd" as const, survivesReboot: true, installedAt: 1, connected: true };
const host = (over: Partial<EngineHostView> = {}): EngineHostView => ({ hostId: "h1", label: "Dell", address: "anh@dell.example.com", pinned: true, bots: 0, ...over });

function renderPanel(over: Partial<ServersPanelProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ServersPanel, {
      hosts: [host()],
      loadError: null,
      setups: {},
      statuses: {},
      error: null,
      onInstall: noop,
      onCancel: noop,
      onCheck: noop,
      onRemove: noop,
      onForget: noop,
      onDismiss: noop,
      onOpenLink: noop,
      ...over,
    }),
  );
}

function setups(...events: EngineSetupEvent[]): SetupViews {
  return events.reduce<SetupViews>((views, event) => reduceSetup(views, event), {});
}

function button(html: string, label: string): string | null {
  const found = new RegExp(`<button([^>]*)>${label}</button>`).exec(html);
  return found ? (found[1] ?? "") : null;
}

test("the page says what servers are for, and offers to manage them only where there is somewhere to do it", () => {
  const html = renderPanel();
  assert.match(html, /<h1>Servers<\/h1>/);
  assert.match(html, /Run your Bots on a computer you own/);
  assert.equal(button(html, "Add or edit servers"), null);
  assert.notEqual(button(renderPanel({ onOpenSshHosts: noop }), "Add or edit servers"), null);
});

test("while loading, after a failure and with no servers there is one clear message each", () => {
  assert.match(renderPanel({ hosts: null }), /role="status">Loading servers…/);
  const failed = renderPanel({ hosts: null, loadError: "ipc closed" });
  assert.match(failed, /role="alert">The servers could not be loaded\. ipc closed/);
  assert.doesNotMatch(failed, /Loading servers/);
  assert.match(renderPanel({ hosts: [] }), /No servers saved yet/);
  assert.doesNotMatch(renderPanel({ hosts: [] }), /<ul class="servers__list"/);
});

test("a server with no engine offers to set one up", () => {
  const html = renderPanel();
  assert.match(html, /<strong>Dell<\/strong>/);
  assert.match(html, /anh@dell\.example\.com/);
  assert.match(html, /No engine yet/);
  assert.notEqual(button(html, "Set up engine"), null);
  for (const gone of ["Remove engine", "Forget", "Check", "Update engine", "Cancel"]) assert.equal(button(html, gone), null, gone);
});

test("a server whose key is not accepted cannot be set up yet, and says what to do", () => {
  const html = renderPanel({ hosts: [host({ pinned: false })] });
  assert.match(html, /Host key not accepted/);
  assert.equal(button(html, "Set up engine"), null);
  assert.match(html, /accept the server&#x27;s host key first/);
});

test("a server with an engine shows how it runs, and can be updated, checked, removed or forgotten", () => {
  const html = renderPanel({ hosts: [host({ engine, bots: 2 })] });
  assert.match(html, /Engine ready/);
  assert.match(html, /Engine 1\.4\.0/);
  assert.match(html, /Runs as a service and starts again after a restart\./);
  assert.match(html, /Bots running here: 2/);
  for (const label of ["Update engine", "Check"]) assert.notEqual(button(html, label), null, label);
  assert.match(html, /aria-label="Remove engine: Dell"/);
  assert.match(html, /aria-label="Forget: Dell"/);
  assert.equal(button(html, "Set up engine"), null);
});

test("an engine that will not return after a restart says so, and so does a Bot waiting for an engine that is not there", () => {
  assert.match(renderPanel({ hosts: [host({ engine: { ...engine, supervisor: "nohup", survivesReboot: false } })] }), /Runs in the background\.[\s\S]*will not start again after the server restarts/);
  assert.match(renderPanel({ hosts: [host({ bots: 3 })] }), /3 Bot\(s\) are set to run here but there is no engine/);
  assert.doesNotMatch(renderPanel({ hosts: [host({ engine, bots: 1 })] }), /no engine\. Set it up/);
});

test("while a setup runs it can only be cancelled, and its steps show as they happen", () => {
  const html = renderPanel({
    hosts: [host({ busy: "installing" })],
    setups: setups({ type: "step", hostId: "h1", step: "probe", state: "done", message: "anh on Linux x64" }, { type: "step", hostId: "h1", step: "cli", state: "running", message: "Installing deyin on the server" }),
  });
  assert.match(html, /Setting up…/);
  assert.notEqual(button(html, "Cancel"), null);
  for (const gone of ["Set up engine", "Update engine", "Remove engine", "Forget", "Check"]) assert.equal(button(html, gone), null, gone);
  assert.match(html, /aria-label="Setup progress"/);
  assert.match(html, /server__step--done[\s\S]*Check the server[\s\S]*Done · anh on Linux x64/);
  assert.match(html, /server__step--running[\s\S]*deyin on the server[\s\S]*In progress · Installing deyin on the server/);
});

test("a step this version does not know shows the words the server gave", () => {
  const html = renderPanel({ hosts: [host({ busy: "installing" })], setups: setups({ type: "step", hostId: "h1", step: "brand-new", state: "running", message: "Doing the new thing" }) });
  assert.match(html, /<span class="server__step-name">Doing the new thing<\/span>/);
});

test("the sign-in a server asks for shows its code and a button that opens the link", () => {
  const html = renderPanel({
    hosts: [host({ busy: "installing" })],
    setups: setups({ type: "sign-in", hostId: "h1", url: "https://openference.com/device?user_code=ABCD-EFGH", code: "ABCD-EFGH" }),
  });
  assert.match(html, /role="alert"[^>]*><strong>Approve the sign-in<\/strong>/);
  assert.match(html, /<code class="server__code">ABCD-EFGH<\/code>/);
  assert.notEqual(button(html, "Open the sign-in page"), null);
});

test("a link that is not safe to open is never offered, and the person is told what to do instead", () => {
  const html = renderPanel({ hosts: [host({ busy: "installing" })], setups: setups({ type: "sign-in", hostId: "h1", url: "javascript:alert(1)", code: "AB-12" }) });
  assert.equal(button(html, "Open the sign-in page"), null);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /not safe to open from here/);
  assert.match(html, /AB-12/);
});

test("a finished setup says how it went, shows any warnings, and can be closed", () => {
  const ok = renderPanel({ hosts: [host({ engine })], setups: setups({ type: "finished", hostId: "h1", ok: true, version: "1.4.0", warnings: ["This server has no cron, so the engine will not start again."] }) });
  assert.match(ok, /Engine 1\.4\.0 is running\./);
  assert.match(ok, /no cron/);
  assert.notEqual(button(ok, "Close"), null);
  const failed = renderPanel({ setups: setups({ type: "finished", hostId: "h1", ok: false, message: "Downloading the engine failed on the server (exit 22)." }) });
  assert.match(failed, /Setup did not finish: Downloading the engine failed on the server \(exit 22\)\./);
  assert.notEqual(button(failed, "Set up engine"), null, "it can be tried again");
});

test("what a server's text says is shown as text, never as markup", () => {
  const html = renderPanel({
    hosts: [host({ label: "<img src=x onerror=alert(1)>" })],
    setups: setups({ type: "finished", hostId: "h1", ok: false, message: "<script>alert(1)</script>" }),
  });
  assert.doesNotMatch(html, /<img |<script>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("asking an engine how it is shows each answer", () => {
  const withStatus = (statuses: ServersPanelProps["statuses"]) => renderPanel({ hosts: [host({ engine })], statuses });
  const checking = withStatus({ h1: { status: "checking" } });
  assert.match(checking, /role="status">Asking the engine…/);
  assert.match(checking, /<button[^>]*disabled[^>]*>Check<\/button>/, "the button waits while it asks");
  assert.match(withStatus({ h1: { status: "error", error: "Could not connect to Dell" } }), /role="alert">Could not connect to Dell/);
  const ok = withStatus({ h1: { status: "ready", view: { version: "1.4.0", startedAt: 1, agentFound: true, agentVersion: "0.9.0", signedIn: true, runningNow: 2, bots: [] } } });
  assert.match(ok, /Engine 1\.4\.0, running now: 2/);
  assert.match(ok, /deyin 0\.9\.0 is there and signed in\./);
  const noAgent = withStatus({ h1: { status: "ready", view: { version: "1", startedAt: 1, agentFound: false, signedIn: false, runningNow: 0, bots: [] } } });
  assert.match(noAgent, /could not find deyin on the server/);
  const signedOut = withStatus({ h1: { status: "ready", view: { version: "1", startedAt: 1, agentFound: true, signedIn: false, runningNow: 0, bots: [] } } });
  assert.match(signedOut, /not signed in/);
});

test("a refusal that has no server row of its own is shown at the foot, and the line is empty otherwise", () => {
  assert.match(renderPanel({ error: "Removing the engine failed on the server (exit 1)." }), /role="alert">Removing the engine failed/);
  assert.match(renderPanel(), /<p class="hint--bad" role="alert" hidden="">/);
});

/* Where a Bot runs ------------------------------------------------------------- */

const bot = { id: "bot_1", harness: "local" as const, hostId: undefined, autoReview: { approvalMode: "read_only" as const }, archived: false };

function renderPlacement(over: Partial<BotPlacementViewProps> = {}): string {
  const subject = over.bot ?? bot;
  return renderToStaticMarkup(
    createElement(BotPlacementView, {
      bot: subject,
      choices: placeChoices([host({ hostId: "a", label: "Dell", engine }), host({ hostId: "b", label: "Pi" })], subject),
      health: null,
      busy: false,
      error: null,
      onChange: noop,
      ...over,
    }),
  );
}

test("a Bot on this computer shows the choice with this computer picked and no notes", () => {
  const html = renderPlacement();
  assert.match(html, /<h3[^>]*>Where this Bot runs<\/h3>/);
  assert.match(html, /<option value="local" selected="">This computer<\/option>/);
  assert.match(html, /<option value="server:a">Dell<\/option>/);
  assert.doesNotMatch(html, /bot-place__notes|Checking the server/);
});

test("a server that has no engine is listed but cannot be picked, with why", () => {
  const html = renderPlacement();
  assert.match(html, /<option value="server:b" disabled="">Pi \(set up the engine first\)<\/option>/);
});

test("a Bot on a server shows it picked, with what to expect there", () => {
  const html = renderPlacement({ bot: { ...bot, harness: "server", hostId: "a", autoReview: { approvalMode: "auto_review" } } });
  assert.match(html, /<option value="server:a" selected="">Dell<\/option>/);
  assert.match(html, /files\. They stay on the computer where they were made|They stay on the computer/);
  assert.match(html, /only use Openference models/);
  assert.match(html, /Auto Review runs read-only/);
});

test("a Bot that already points at a server that is gone shows where, and can still be moved", () => {
  const html = renderPlacement({ bot: { ...bot, harness: "server", hostId: "gone" } });
  assert.match(html, /<option value="server:gone" selected="">a server that is no longer saved<\/option>/);
  assert.match(html, /<option value="local">This computer<\/option>/);
});

test("the select waits while a move is saved, and for an archived Bot", () => {
  assert.match(renderPlacement({ busy: true }), /<select[^>]*disabled/);
  assert.match(renderPlacement({ bot: { ...bot, archived: true } }), /<select[^>]*disabled/);
  assert.doesNotMatch(renderPlacement(), /<select[^>]*disabled/);
});

test("how the server is shows under the choice", () => {
  const server = { ...bot, harness: "server" as const, hostId: "a" };
  assert.match(renderPlacement({ bot: server, health: { status: "checking" } }), /role="status">Checking the server…/);
  assert.match(renderPlacement({ bot: server, health: { status: "ready" } }), /The server is ready\./);
  assert.match(renderPlacement({ bot: server, health: { status: "ready", version: "1.4.0" } }), /The server is ready \(engine 1\.4\.0\)\./);
  assert.match(renderPlacement({ bot: server, health: { status: "notReady", reason: "deyin on the server is not signed in." } }), /This Bot cannot run there yet: deyin on the server is not signed in\./);
});

test("a refusal when moving is shown, and the set-up-servers button appears only where it can go", () => {
  assert.match(renderPlacement({ error: "Choose a server to run on first." }), /role="alert">Choose a server to run on first\./);
  assert.equal(button(renderPlacement(), "Set up servers"), null);
  assert.notEqual(button(renderPlacement({ onOpenServers: noop }), "Set up servers"), null);
});
