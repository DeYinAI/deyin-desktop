import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeBridge, ChromeBridgeError, isAllowedHost, isAllowedOrigin } from "../host/chrome-bridge.js";
import { DEYIN_EXTENSION_ID, sha256Hex } from "../host/chrome-protocol.js";
import { FakeExtension, GOOD_ORIGIN, pair, tab, waitFor } from "./helpers/fake-extension.js";

describe("origin and host checks", () => {
  it("accepts only configured extension ids", () => {
    const ids = new Set([DEYIN_EXTENSION_ID, "a".repeat(32)]);
    assert.equal(isAllowedOrigin(GOOD_ORIGIN, ids), true);
    assert.equal(isAllowedOrigin(`chrome-extension://${"a".repeat(32)}`, ids), true);
    assert.equal(isAllowedOrigin(`chrome-extension://${"b".repeat(32)}`, ids), false);
    assert.equal(isAllowedOrigin("https://evil.example", ids), false);
    assert.equal(isAllowedOrigin(`${GOOD_ORIGIN}/`, ids), false);
    assert.equal(isAllowedOrigin(undefined, ids), false);
  });

  it("accepts only loopback hosts on the relay port", () => {
    assert.equal(isAllowedHost("127.0.0.1:9410", 9410), true);
    assert.equal(isAllowedHost("localhost:9410", 9410), true);
    assert.equal(isAllowedHost("evil.example:9410", 9410), false);
    assert.equal(isAllowedHost("127.0.0.1:9999", 9410), false);
    assert.equal(isAllowedHost(undefined, 9410), false);
  });
});

describe("ChromeBridge", () => {
  let dir: string;
  let bridge: ChromeBridge;
  let port: number;
  const opened: FakeExtension[] = [];

  async function ext(headers?: Record<string, string>): Promise<FakeExtension> {
    const e = await FakeExtension.connect(port, headers);
    opened.push(e);
    return e;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "deyin-chrome-bridge-"));
    bridge = new ChromeBridge({ dataDir: dir, ports: [0] });
    await bridge.start();
    port = bridge.snapshot().port ?? 0;
  });

  afterEach(async () => {
    for (const e of opened.splice(0)) e.ws.terminate();
    await bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses upgrades with a wrong origin or a rebinding host", async () => {
    assert.equal(await FakeExtension.connectExpectingFailure(port, { Origin: "https://evil.example" }), 403);
    assert.equal(await FakeExtension.connectExpectingFailure(port, {}), 403);
    assert.equal(await FakeExtension.connectExpectingFailure(port, { Origin: GOOD_ORIGIN, Host: "evil.example" }), 403);
  });

  it("rejects an unpaired browser while no pairing window is open", async () => {
    const e = await ext();
    e.hello();
    const rejected = await (async () => {
      await e.next("welcome");
      return e.next("rejected");
    })();
    assert.equal(rejected.reason, "not_pairing");
    assert.equal(await e.closed, 4007);
    assert.equal(bridge.isConnected(), false);
  });

  it("pairs with commit-reveal nonces and stores only a token hash", async () => {
    const e = await ext();
    const token = await pair(bridge, e);
    const snap = bridge.snapshot();
    assert.equal(snap.connection, "connected");
    assert.equal(snap.pairingCode, null, "pairing window closes once paired");
    assert.equal(snap.paired.length, 1);
    const raw = readFileSync(join(dir, "identity.json"), "utf8");
    assert.ok(!raw.includes(token), "the raw token must never be written to disk");
    assert.ok(raw.includes(sha256Hex(token)));
  });

  it("reconnects with the token after a restart and rejects a wrong one", async () => {
    const first = await ext();
    const token = await pair(bridge, first);
    first.close();
    await waitFor(() => !bridge.isConnected(), "disconnect");
    await bridge.stop();

    bridge = new ChromeBridge({ dataDir: dir, ports: [0] });
    await bridge.start();
    port = bridge.snapshot().port ?? 0;

    const bad = await ext();
    bad.hello("browser-aaaa-1111", "not-the-token");
    assert.equal((await bad.next("rejected")).reason, "token");

    const good = await ext();
    good.hello("browser-aaaa-1111", token);
    assert.equal((await good.next("welcome")).paired, true);
    await waitFor(() => bridge.isConnected(), "reconnect");
  });

  it("round-trips requests and surfaces extension errors", async () => {
    const e = await ext();
    await pair(bridge, e);

    const ok = bridge.request<{ n: number }>("tabs.list");
    const req = await e.next("request");
    assert.equal(req.op, "tabs.list");
    e.send({ type: "response", id: req.id, ok: true, value: { n: 3 } });
    assert.deepEqual(await ok, { n: 3 });

    const bad = bridge.request("tabs.close", { tabId: 9 });
    const req2 = await e.next("request");
    e.send({ type: "response", id: req2.id, ok: false, error: "No such tab" });
    await assert.rejects(bad, (err: unknown) => err instanceof ChromeBridgeError && err.code === "extension_error" && /No such tab/.test(err.message));
  });

  it("times out requests and rejects them when Chrome disconnects", async () => {
    const e = await ext();
    await pair(bridge, e);
    await assert.rejects(bridge.request("tabs.list", {}, 50), (err: unknown) => err instanceof ChromeBridgeError && err.code === "timeout");

    await e.next("request"); // the request that timed out above was still delivered
    const pending = bridge.request("tabs.list", {}, 5000);
    await e.next("request");
    e.ws.terminate();
    await assert.rejects(pending, (err: unknown) => err instanceof ChromeBridgeError && err.code === "disconnected");
  });

  it("tells the caller how to connect when nothing is paired", async () => {
    await assert.rejects(bridge.request("tabs.list"), (err: unknown) => err instanceof ChromeBridgeError && err.code === "not_connected" && /Install the Deyin extension/.test(err.message));
  });

  it("blocks requests and fails in-flight ones once the user presses Stop", async () => {
    const e = await ext();
    await pair(bridge, e);
    const inFlight = bridge.request("cdp", { tabId: 1 }, 5000);
    await e.next("request");
    e.send({ type: "stopped", stopped: true });
    await assert.rejects(inFlight, (err: unknown) => err instanceof ChromeBridgeError && err.code === "stopped");
    assert.equal(bridge.isStopped(), true);
    await assert.rejects(bridge.request("cdp", { tabId: 1 }), (err: unknown) => err instanceof ChromeBridgeError && err.code === "stopped");

    const resume = bridge.request("control.resume");
    const req = await e.next("request");
    e.send({ type: "response", id: req.id, ok: true, value: null });
    await resume;
    e.send({ type: "stopped", stopped: false });
    await waitFor(() => !bridge.isStopped(), "resume");
  });

  it("tracks tabs and forwards CDP events and detaches", async () => {
    const e = await ext();
    await pair(bridge, e);
    const events: Array<[number, string]> = [];
    const detached: number[] = [];
    bridge.on("cdp", (tabId: number, method: string) => events.push([tabId, method]));
    bridge.on("detached", (tabId: number) => detached.push(tabId));

    e.send({ type: "state", stopped: false, tabs: [tab(1), tab(2)] });
    await waitFor(() => bridge.snapshot().tabs.length === 2, "state");
    e.send({ type: "tabEvent", kind: "updated", tabId: 2, tab: tab(2, { title: "renamed", attached: true }) });
    e.send({ type: "tabEvent", kind: "removed", tabId: 1 });
    await waitFor(() => bridge.snapshot().tabs.length === 1, "tab removal");
    assert.equal(bridge.snapshot().tabs[0]?.title, "renamed");

    e.send({ type: "event", tabId: 2, method: "Page.loadEventFired", params: {} });
    e.send({ type: "detached", tabId: 2, reason: "target_closed" });
    await waitFor(() => detached.length === 1, "detach");
    assert.deepEqual(events, [[2, "Page.loadEventFired"]]);
    assert.equal(bridge.snapshot().tabs[0]?.attached, false);
  });

  it("ignores tab state and CDP events from a connection that has not finished pairing", async () => {
    const e = await ext();
    bridge.beginPairing();
    e.hello();
    await e.next("welcome");
    const seen: string[] = [];
    bridge.on("cdp", (_tabId: number, method: string) => seen.push(method));
    e.send({ type: "state", stopped: false, tabs: [tab(7)] });
    e.send({ type: "event", tabId: 7, method: "Page.loadEventFired", params: {} });
    e.send({ type: "paired" }); // skipping the nonce exchange must not promote the connection
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(bridge.snapshot().tabs.length, 0);
    assert.deepEqual(seen, []);
    assert.equal(bridge.isConnected(), false);
    assert.equal(bridge.snapshot().paired.length, 0);
  });

  it("forgets a paired browser and drops its connection", async () => {
    const e = await ext();
    await pair(bridge, e);
    bridge.forget("browser-aaaa-1111");
    assert.equal(await e.closed, 4003);
    assert.equal(bridge.snapshot().paired.length, 0);
  });

  it("lets a newer trusted connection replace the old one", async () => {
    const first = await ext();
    const token = await pair(bridge, first);
    const second = await ext();
    second.hello("browser-aaaa-1111", token);
    await second.next("welcome");
    assert.equal(await first.closed, 4009);
    await waitFor(() => bridge.isConnected(), "second active");
  });

  it("cancelPairing closes the half-open handshake", async () => {
    const e = await ext();
    bridge.beginPairing();
    e.hello();
    await e.next("welcome");
    await waitFor(() => bridge.snapshot().connection === "pairing", "pairing state");
    assert.equal(bridge.snapshot().pairingCode, null, "no code until the extension sends its nonce");
    bridge.cancelPairing();
    assert.equal(await e.closed, 4002);
    assert.equal(bridge.snapshot().connection, "disconnected");
  });
});
