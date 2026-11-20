import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChromeBridgeStatus } from "@deyin/contract";
import type { ToolContext } from "@deyin/agent-core";
import { ChromeService, syncDirectory } from "../host/chrome-service.js";
import { DEYIN_EXTENSION_ID } from "../host/chrome-protocol.js";
import { FakeExtension, ScriptedBrowser, pair, waitFor } from "./helpers/fake-extension.js";

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function ctx(threadId: string): ToolContext {
  return { cwd: "/", todos: [], sessionMeta: { threadId } } as ToolContext;
}

describe("syncDirectory", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deyin-chrome-sync-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("makes dest match src: adds, updates and removes, and reports whether anything changed", () => {
    const src = join(root, "src");
    const dest = join(root, "dest");
    write(join(src, "manifest.json"), '{"v":1}');
    write(join(src, "icons", "a.png"), "png-a");
    assert.equal(syncDirectory(src, dest), true);
    assert.equal(readFileSync(join(dest, "icons", "a.png"), "utf8"), "png-a");

    assert.equal(syncDirectory(src, dest), false, "an up-to-date copy is left alone");

    write(join(src, "manifest.json"), '{"v":2}');
    write(join(dest, "stale.js"), "old");
    assert.equal(syncDirectory(src, dest), true);
    assert.equal(readFileSync(join(dest, "manifest.json"), "utf8"), '{"v":2}');
    assert.equal(existsSync(join(dest, "stale.js")), false, "files no longer shipped are removed");
    assert.deepEqual(readdirSync(dest).sort(), ["icons", "manifest.json"]);
  });
});

describe("ChromeService", () => {
  let root: string;
  let enabled: boolean;
  let service: ChromeService;
  let extensionSource: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deyin-chrome-service-"));
    extensionSource = join(root, "shipped");
    write(join(extensionSource, "manifest.json"), "{}");
    write(join(extensionSource, "service-worker.js"), "// worker");
    enabled = true;
    service = new ChromeService({
      dataDir: join(root, "data"),
      extensionSource,
      isEnabled: () => enabled,
      strategy: () => "group",
      requestOriginApproval: async () => "once",
      ports: [0],
    });
  });

  afterEach(async () => {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("does nothing until enabled, then listens and exposes the extension folder", async () => {
    enabled = false;
    await service.applyEnabled();
    let status = service.status();
    assert.equal(status.enabled, false);
    assert.equal(status.listening, false);
    assert.equal(status.extensionPath, null);

    enabled = true;
    await service.applyEnabled();
    status = service.status();
    assert.equal(status.enabled, true);
    assert.equal(status.listening, true);
    assert.equal(status.extensionId, DEYIN_EXTENSION_ID);
    assert.equal(status.extensionPath, join(root, "data", "extension"));
    assert.equal(readFileSync(join(status.extensionPath ?? "", "service-worker.js"), "utf8"), "// worker");

    enabled = false;
    await service.applyEnabled();
    assert.equal(service.status().listening, false, "turning it off closes the relay");
  });

  it("keeps the extension folder current when the shipped files change", async () => {
    await service.applyEnabled();
    write(join(extensionSource, "service-worker.js"), "// worker v2");
    await service.applyEnabled();
    assert.equal(readFileSync(join(root, "data", "extension", "service-worker.js"), "utf8"), "// worker v2");
  });

  it("has no extension path when this build ships no extension", async () => {
    const bare = new ChromeService({
      dataDir: join(root, "bare"),
      extensionSource: null,
      isEnabled: () => true,
      strategy: () => "group",
      requestOriginApproval: async () => "deny",
      ports: [0],
    });
    try {
      await bare.applyEnabled();
      assert.equal(bare.status().extensionPath, null);
      assert.equal(bare.status().listening, true, "the relay still runs; the user can use a manually loaded copy");
    } finally {
      await bare.dispose();
    }
  });

  it("reports tabs with their kind and owning conversation, and announces changes", async () => {
    await service.applyEnabled();
    const port = service.status().port;
    assert.ok(port);
    const ext = await FakeExtension.connect(port);
    await pair(service.bridge, ext);
    const browser = new ScriptedBrowser(ext);
    const seen: ChromeBridgeStatus[] = [];
    service.onStatus((s) => seen.push(s));

    const open = service.tools().find((t) => t.name === "chrome_open");
    assert.ok(open);
    await open.execute({ url: "http://localhost:3000/" }, ctx("thread-1"));
    const shared = browser.addSharedTab("https://example.com/doc");
    await waitFor(() => service.status().tabs.some((t) => t.id === shared.id), "shared tab reported");

    const tabs = service.status().tabs;
    const agentTab = tabs.find((t) => t.kind === "agent");
    assert.equal(agentTab?.owner, "thread-1");
    assert.equal(tabs.find((t) => t.id === shared.id)?.kind, "shared");
    assert.equal(tabs.find((t) => t.id === shared.id)?.owner, undefined);
    assert.ok(seen.length > 0, "status listeners were notified");
    ext.ws.terminate();
  });

  it("closeAgentTabs removes only the tabs Deyin opened", async () => {
    await service.applyEnabled();
    const ext = await FakeExtension.connect(service.status().port ?? 0);
    await pair(service.bridge, ext);
    const browser = new ScriptedBrowser(ext);
    const open = service.tools().find((t) => t.name === "chrome_open");
    assert.ok(open);
    await open.execute({ url: "http://localhost:3000/" }, ctx("thread-1"));
    const shared = browser.addSharedTab("https://example.com/");
    await waitFor(() => service.status().tabs.length === 2, "both tabs reported");

    const after = await service.closeAgentTabs();
    assert.deepEqual(after.tabs.map((t) => t.id), [shared.id]);
    ext.ws.terminate();
  });

  it("surfaces a refused resume instead of throwing", async () => {
    await service.applyEnabled();
    const ext = await FakeExtension.connect(service.status().port ?? 0);
    await pair(service.bridge, ext);
    ext.onRequest((req) => ext.send({ type: "response", id: req.id, ok: false, error: "Resume from the Deyin extension popup." }));
    ext.send({ type: "stopped", stopped: true });
    await waitFor(() => service.status().stopped, "stopped");

    const status = await service.resume();
    assert.equal(status.stopped, true);
    assert.match(status.error ?? "", /extension popup/);
    ext.ws.terminate();
  });

  it("round-trips approved origins and ignores junk", async () => {
    assert.deepEqual(service.setApprovedOrigins(["https://b.example/x", "not a url", "https://a.example"]), ["https://a.example", "https://b.example"]);
    assert.deepEqual(service.getApprovedOrigins(), ["https://a.example", "https://b.example"]);
  });
});
