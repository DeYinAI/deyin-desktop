import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, ToolDefinition } from "@deyin/agent-core";
import { ChromeBridge } from "../host/chrome-bridge.js";
import { ChromeControl, type OriginApprovalRequest, type OriginDecision } from "../host/chrome-control.js";
import { createChromeTools } from "../host/chrome-tools.js";
import { FakeExtension, ScriptedBrowser, pair, waitFor } from "./helpers/fake-extension.js";

interface Rig {
  dir: string;
  bridge: ChromeBridge;
  control: ChromeControl;
  browser: ScriptedBrowser;
  asked: OriginApprovalRequest[];
  decide: { next: OriginDecision };
  saved: Array<{ threadId: string; mediaType: string }>;
  tools: Map<string, ToolDefinition>;
}

async function makeRig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "deyin-chrome-control-"));
  const bridge = new ChromeBridge({ dataDir: join(dir, "bridge"), ports: [0] });
  await bridge.start();
  const asked: OriginApprovalRequest[] = [];
  const decide = { next: "once" as OriginDecision };
  const saved: Rig["saved"] = [];
  const control = new ChromeControl({
    bridge,
    approvedOriginsFile: join(dir, "approved.json"),
    strategy: () => "group",
    requestOriginApproval: async (req) => {
      asked.push(req);
      return decide.next;
    },
    saveImage: (threadId, image) => {
      saved.push({ threadId, mediaType: image.mediaType });
      return "shot-1.png";
    },
  });
  const ext = await FakeExtension.connect(bridge.snapshot().port ?? 0);
  await pair(bridge, ext);
  const browser = new ScriptedBrowser(ext);
  const tools = new Map(createChromeTools(control).map((t) => [t.name, t]));
  return { dir, bridge, control, browser, asked, decide, saved, tools };
}

function ctx(threadId: string): ToolContext {
  return { cwd: "/", todos: [], sessionMeta: { threadId } } as ToolContext;
}

describe("ChromeControl", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await makeRig();
  });
  afterEach(async () => {
    rig.browser.ext.ws.terminate();
    await rig.bridge.stop();
    rmSync(rig.dir, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown>, thread = "t1"): Promise<string> => {
    const tool = rig.tools.get(name);
    assert.ok(tool, `missing tool ${name}`);
    return tool.execute(args, ctx(thread));
  };

  it("opens agent tabs for the conversation, attaching the debugger lazily and only once", async () => {
    const out = await call("chrome_open", { url: "http://localhost:5173/" });
    assert.match(out, /Opened tab 100/);
    assert.equal(rig.browser.requests.find((r) => r.op === "tabs.create")?.args.strategy, "group");
    assert.equal(rig.browser.count("debugger.attach"), 1);

    const snap = await call("chrome_snapshot", {});
    assert.match(snap, /textbox "Email" \[ref=e1\]/);
    assert.match(snap, /button "Sign in" \[ref=e2\]/);
    await call("chrome_snapshot", { query: "email" });
    assert.equal(rig.browser.count("debugger.attach"), 1, "no second attach");
    assert.ok(rig.browser.cdpCalls.some((c) => c.method === "Page.enable"), "CDP domains enabled on first attach");
    assert.equal(rig.asked.length, 0, "localhost needs no approval");
  });

  it("asks once per origin, remembers 'once' per conversation and 'always' across restarts", async () => {
    rig.decide.next = "once";
    await call("chrome_open", { url: "https://example.com/a" });
    await call("chrome_open", { url: "https://example.com/b" });
    assert.equal(rig.asked.length, 1, "same origin, same conversation: asked once");
    await call("chrome_open", { url: "https://example.com/c" }, "t2");
    assert.equal(rig.asked.length, 2, "'once' does not carry to another conversation");

    rig.decide.next = "always";
    await call("chrome_open", { url: "https://docs.example.org/" });
    assert.deepEqual(rig.control.getApprovedOrigins(), ["https://docs.example.org"]);
    assert.deepEqual(JSON.parse(readFileSync(join(rig.dir, "approved.json"), "utf8")), ["https://docs.example.org"]);
    await call("chrome_open", { url: "https://docs.example.org/x" }, "t3");
    assert.equal(rig.asked.length, 3, "'always' covers every conversation");

    const reborn = new ChromeControl({
      bridge: rig.bridge,
      approvedOriginsFile: join(rig.dir, "approved.json"),
      strategy: () => "group",
      requestOriginApproval: async () => "deny",
    });
    assert.deepEqual(reborn.getApprovedOrigins(), ["https://docs.example.org"]);
  });

  it("refuses with a clear message when the user denies an origin, and never opens the tab", async () => {
    rig.decide.next = "deny";
    const out = await call("chrome_open", { url: "https://bank.example/" });
    assert.match(out, /^ERROR: .*did not allow Deyin to use https:\/\/bank\.example/);
    assert.equal(rig.browser.count("tabs.create"), 0);
  });

  it("refuses browser-internal pages without asking anyone", async () => {
    const out = await call("chrome_open", { url: "chrome://settings" });
    assert.match(out, /^ERROR: Blocked page type/);
    assert.equal(rig.asked.length, 0);
    assert.equal(rig.browser.count("tabs.create"), 0);
  });

  it("does not let one conversation use another's tab, but shares shared tabs", async () => {
    await call("chrome_open", { url: "http://localhost:3000/" }, "t1");
    const other = await call("chrome_snapshot", { tab_id: 100 }, "t2");
    assert.match(other, /^ERROR: Chrome tab 100 belongs to another conversation/);

    const shared = rig.browser.addSharedTab("http://localhost:4000/");
    await waitFor(() => rig.bridge.snapshot().tabs.some((t) => t.id === shared.id), "shared tab known");
    assert.match(await call("chrome_snapshot", { tab_id: shared.id }, "t2"), /textbox "Email"/);
    assert.match(await call("chrome_status", {}, "t2"), /\[shared\]/);
    assert.ok(!/ 100 \[deyin\]/.test(await call("chrome_status", {}, "t2")), "t2 must not even see t1's tab");
  });

  it("serializes commands per tab", async () => {
    await call("chrome_open", { url: "http://localhost:3000/" });
    const order: string[] = [];
    rig.browser.cdp = async (_tab, method) => {
      if (method === "Runtime.evaluate") {
        order.push("start");
        await new Promise((r) => setTimeout(r, 40));
        order.push("end");
        return { result: { value: "ok" } };
      }
      return {};
    };
    await Promise.all([call("chrome_evaluate", { expression: "1" }), call("chrome_evaluate", { expression: "2" })]);
    assert.deepEqual(order, ["start", "end", "start", "end"]);
  });

  it("re-checks the origin after navigation and backs out of a refused redirect", async () => {
    await call("chrome_open", { url: "http://localhost:3000/" });
    rig.decide.next = "deny";
    rig.browser.cdp = (tabId, method, params, browser) => {
      if (method === "Page.navigate" && params.url !== "about:blank") {
        browser.setUrl(tabId, "https://evil.example/landing"); // pretend the page redirected
        return {};
      }
      if (method === "Runtime.evaluate") {
        const loading = String(params.expression).includes("readyState");
        return { result: { value: loading ? "complete" : { url: browser.tabs.get(tabId)?.url, title: "x" } } };
      }
      return {};
    };
    const out = await call("chrome_navigate", { url: "http://localhost:3000/go" });
    assert.match(out, /^ERROR: .*evil\.example/);
    assert.ok(
      rig.browser.cdpCalls.some((c) => c.method === "Page.navigate" && c.params.url === "about:blank"),
      "the tab is sent back to about:blank",
    );
  });

  it("drops the attachment when the extension detaches and re-attaches on the next use", async () => {
    await call("chrome_open", { url: "http://localhost:3000/" });
    assert.equal(rig.browser.count("debugger.attach"), 1);
    const t = rig.browser.tabs.get(100);
    if (t) t.attached = false;
    rig.browser.ext.send({ type: "detached", tabId: 100, reason: "target_closed" });
    await waitFor(() => rig.bridge.snapshot().tabs.find((x) => x.id === 100)?.attached === false, "detach propagated");
    await call("chrome_snapshot", {});
    assert.equal(rig.browser.count("debugger.attach"), 2);
  });

  it("Stop blocks every tool until resumed, then work continues", async () => {
    await call("chrome_open", { url: "http://localhost:3000/" });
    const activity: boolean[] = [];
    rig.control.on("activity", (a: boolean) => activity.push(a));
    await rig.control.stop();
    assert.equal(rig.browser.stopped, true);
    assert.match(await call("chrome_snapshot", {}), /^ERROR: Chrome control is stopped/);
    assert.equal(rig.control.isActive(), false);

    await rig.control.resume();
    await waitFor(() => !rig.bridge.isStopped(), "resume propagated");
    assert.match(await call("chrome_snapshot", {}), /textbox "Email"/);
    assert.equal(rig.browser.count("debugger.attach"), 2, "Stop detached everything; use re-attaches");
  });

  it("stores screenshots for the thread and returns the inline-image directive", async () => {
    await call("chrome_open", { url: "http://localhost:3000/" });
    const out = await call("chrome_screenshot", {}, "t1");
    assert.match(out, /::deyin-inline-image\{file="shot-1\.png" alt="Chrome screenshot"\}/);
    assert.deepEqual(rig.saved, [{ threadId: "t1", mediaType: "image/png" }]);
  });

  it("reports navigation and dialogs that an action causes", async () => {
    await call("chrome_open", { url: "http://localhost:3000/" });
    await call("chrome_snapshot", {});
    rig.browser.cdp = (tabId, method, _params, browser) => {
      if (method === "DOM.getContentQuads") {
        browser.setUrl(tabId, "http://localhost:3000/dashboard"); // clicking navigated
        return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] };
      }
      return {};
    };
    const out = await call("chrome_click", { ref: "e2" });
    assert.match(out, /Clicked ref e2/);
    assert.match(out, /Page is now http:\/\/localhost:3000\/dashboard/);
  });

  it("runs a batch in order and stops at the first failing step", async () => {
    await call("chrome_open", { url: "http://localhost:3000/" });
    await call("chrome_snapshot", {});
    const out = await call("chrome_batch", {
      steps: [{ type: "fill", ref: "e1", value: "a@b.c" }, { type: "click", ref: "e99" }, { type: "press", key: "Enter" }],
    });
    assert.match(out, /1\. /);
    assert.match(out, /2\. ERROR: Unknown ref "e99"/);
    assert.match(out, /Stopped after step 2 of 3/);
    assert.ok(!/3\. /.test(out));
  });

  it("tells the model how to recover when Chrome is not connected", async () => {
    rig.browser.ext.ws.terminate();
    await waitFor(() => !rig.bridge.isConnected(), "disconnect");
    assert.match(await call("chrome_open", { url: "http://localhost:3000/" }), /^ERROR: Chrome is not connected\./);
    assert.match(await call("chrome_status", {}), /not connected/);
  });

  it("closes only tabs Deyin opened", async () => {
    await call("chrome_open", { url: "http://localhost:3000/" });
    const shared = rig.browser.addSharedTab("http://localhost:4000/");
    await waitFor(() => rig.bridge.snapshot().tabs.some((t) => t.id === shared.id), "shared tab known");
    assert.match(await call("chrome_tabs", { action: "close", tab_id: shared.id }), /^ERROR: Only tabs Deyin opened can be closed/);
    assert.match(await call("chrome_tabs", { action: "close", tab_id: 100 }), /Closed tab 100/);
    assert.equal(rig.browser.tabs.has(100), false);
  });
});

describe("chrome tool definitions", () => {
  it("have unique chrome_ names, valid schemas, and read/execute tiers", async () => {
    const rig = await makeRig();
    try {
      const tools = [...rig.tools.values()];
      assert.ok(tools.length >= 15);
      assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
      for (const tool of tools) {
        assert.match(tool.name, /^chrome_[a-z_]+$/);
        assert.equal(tool.parameters.type, "object");
        assert.ok(tool.description.length > 20, tool.name);
        assert.ok(tool.tier === "read" || tool.tier === "execute", tool.name);
        for (const required of tool.parameters.required ?? []) assert.ok(required in tool.parameters.properties, `${tool.name}.${required}`);
      }
      const reads = tools.filter((t) => t.tier === "read").map((t) => t.name);
      assert.deepEqual(reads.sort(), ["chrome_logs", "chrome_screenshot", "chrome_snapshot", "chrome_status", "chrome_wait"]);
    } finally {
      rig.browser.ext.ws.terminate();
      await rig.bridge.stop();
      rmSync(rig.dir, { recursive: true, force: true });
    }
  });
});
