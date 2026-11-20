import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext, ToolDefinition } from "@deyin/agent-core";
import { createBrowserTools, type BrowserToolHost, type TabAction } from "../host/browser-tools.js";
import type { CdpPage } from "../host/cdp-page.js";

/** The slice of CdpPage the tools call, recording what they asked for. */
class StubPage {
  calls: string[] = [];
  selectors = new Map<string, string>([["#go", "e5"], ["input[name=email]", "e6"]]);
  dialog: { defaultPrompt: string } | null = null;

  async refForSelector(selector: string): Promise<string> {
    this.calls.push(`refForSelector ${selector}`);
    const ref = this.selectors.get(selector);
    if (!ref) throw new Error(`no element matches ${selector}`);
    return ref;
  }
  async click(t: { ref: string }): Promise<string> {
    this.calls.push(`click ${t.ref}`);
    return `Clicked ref ${t.ref}`;
  }
  async hover(t: { ref: string }): Promise<string> {
    this.calls.push(`hover ${t.ref}`);
    return `Hovered ref ${t.ref}`;
  }
  async drag(a: { ref: string }, b: { ref: string }): Promise<string> {
    this.calls.push(`drag ${a.ref}->${b.ref}`);
    return "Dragged";
  }
  async type(text: string, ref?: string): Promise<string> {
    this.calls.push(`type ${JSON.stringify(text)} ${ref ?? "-"}`);
    return "Typed";
  }
  async fill(ref: string, value: string): Promise<string> {
    this.calls.push(`fill ${ref} ${JSON.stringify(value)}`);
    if (ref === "e6" && value === "boom") throw new Error("Ref e6 is a checkbox input; use click instead of fill.");
    return `Filled ${ref}`;
  }
  async press(key: string): Promise<string> {
    this.calls.push(`press ${key}`);
    return `Pressed ${key}`;
  }
  async scroll(o: { deltaY?: number }): Promise<string> {
    this.calls.push(`scroll ${o.deltaY}`);
    return "Scrolled";
  }
  async snapshot(o: { ref?: string; query?: string }): Promise<string> {
    this.calls.push(`snapshot ${JSON.stringify(o)}`);
    return "- page";
  }
  consoleTail(n: number): string {
    this.calls.push(`console ${n}`);
    return "console log";
  }
  networkTail(n: number): string {
    this.calls.push(`network ${n}`);
    return "network log";
  }
  pendingDialog(): { defaultPrompt: string } | null {
    return this.dialog;
  }
  async handleDialog(accept: boolean, promptText?: string): Promise<string> {
    this.calls.push(`dialog ${accept} ${promptText ?? "-"}`);
    return "Handled";
  }
}

function setup() {
  const page = new StubPage();
  const host: BrowserToolHost & { tabCalls: unknown[][]; navigated: string[] } = {
    tabCalls: [],
    navigated: [],
    withPage: (fn) => fn(page as unknown as CdpPage),
    navigate: async (url) => {
      host.navigated.push(url);
      return `Loaded ${url}`;
    },
    screenshot: async (threadId) => `shot for ${threadId ?? "nobody"}`,
    manageTabs: async (action: TabAction, url?: string, tabId?: number) => {
      host.tabCalls.push([action, url, tabId]);
      return `tabs ${action}`;
    },
  };
  const tools = new Map(createBrowserTools(host).map((t) => [t.name, t]));
  const call = (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const tool: ToolDefinition | undefined = tools.get(name);
    assert.ok(tool, `missing tool ${name}`);
    return tool.execute(args, { cwd: "/", todos: [], sessionMeta: { threadId: "t1" } } as ToolContext);
  };
  return { page, host, tools, call };
}

describe("browser tools", () => {
  let rig: ReturnType<typeof setup>;
  beforeEach(() => {
    rig = setup();
  });

  it("keeps the tool names the agent, skills and saved subagents already use", () => {
    assert.deepEqual(
      [...rig.tools.keys()].sort(),
      [
        "browser_click",
        "browser_console",
        "browser_drag",
        "browser_fill",
        "browser_fill_form",
        "browser_handle_dialog",
        "browser_hover",
        "browser_navigate",
        "browser_network",
        "browser_press",
        "browser_screenshot",
        "browser_scroll",
        "browser_snapshot",
        "browser_tabs",
        "browser_type",
      ],
    );
    const tier = (n: string) => rig.tools.get(n)?.tier;
    for (const n of ["browser_snapshot", "browser_screenshot", "browser_console", "browser_network"]) assert.equal(tier(n), "read", n);
    for (const n of ["browser_click", "browser_type", "browser_fill", "browser_navigate", "browser_handle_dialog"]) assert.equal(tier(n), "execute", n);
  });

  it("clicks by ref, or by selector resolved to a ref, and says which when both were possible", async () => {
    assert.equal(await rig.call("browser_click", { ref: "e12" }), "Clicked ref e12");
    assert.equal(await rig.call("browser_click", { selector: "#go" }), "Clicked ref e5 (#go)");
    assert.equal(await rig.call("browser_click", { ref: "e1", selector: "#go" }), "Clicked ref e1", "a ref wins over a selector");
    assert.deepEqual(rig.page.calls, ["click e12", "refForSelector #go", "click e5", "click e1"]);
  });

  it("returns errors as text instead of throwing, with a useful message", async () => {
    assert.match(await rig.call("browser_click", {}), /^ERROR: Provide a ref .* or a CSS selector/);
    assert.match(await rig.call("browser_click", { ref: "button.submit" }), /^ERROR: Invalid browser ref: button\.submit/);
    assert.match(await rig.call("browser_click", { selector: "#nope" }), /^ERROR: no element matches #nope/);
    assert.deepEqual(rig.page.calls, ["refForSelector #nope"], "an invalid ref never reaches the page");
  });

  it("types into the focused element, or into a named one", async () => {
    await rig.call("browser_type", { text: "hi" });
    await rig.call("browser_type", { text: "yo", selector: "input[name=email]" });
    await rig.call("browser_type", { text: "ya", ref: "e3" });
    assert.deepEqual(rig.page.calls, ['type "hi" -', "refForSelector input[name=email]", 'type "yo" e6', 'type "ya" e3']);
  });

  it("fills one field by ref or selector, and many fields reporting each outcome", async () => {
    assert.equal(await rig.call("browser_fill", { selector: "input[name=email]", value: "a@b.c" }), "Filled e6");
    assert.match(await rig.call("browser_fill", { value: "x" }), /^ERROR: Provide a ref .* for the field/);

    const out = await rig.call("browser_fill_form", {
      fields: [
        { selector: "input[name=email]", value: "ok" },
        { selector: "#absent", value: "x" },
        { selector: "input[name=email]", value: "boom" },
        { ref: "e9", value: "fine" },
      ],
    });
    assert.deepEqual(out.split("\n"), ["OK input[name=email]", "MISS #absent", "ERROR input[name=email]: Ref e6 is a checkbox input; use click instead of fill.", "OK e9"]);
  });

  it("presses keys and chords, scrolls with the old default, and reads the page", async () => {
    await rig.call("browser_press", { key: "Control+A" });
    await rig.call("browser_scroll", {});
    await rig.call("browser_scroll", { delta_y: -300 });
    await rig.call("browser_snapshot", {});
    await rig.call("browser_snapshot", { query: "email", ref: "e4" });
    assert.match(await rig.call("browser_snapshot", { ref: "x" }), /^ERROR: Invalid browser ref: x/);
    assert.deepEqual(rig.page.calls, ["press Control+A", "scroll 600", "scroll -300", "snapshot {}", 'snapshot {"ref":"e4","query":"email"}']);
  });

  it("hovers and drags using refs and selectors interchangeably", async () => {
    await rig.call("browser_hover", { selector: "#go" });
    await rig.call("browser_drag", { from_ref: "e1", to_selector: "#go" });
    assert.match(await rig.call("browser_drag", { from_ref: "e1" }), /^ERROR: Provide a ref .* for the drop target/);
    assert.deepEqual(rig.page.calls, ["refForSelector #go", "hover e5", "refForSelector #go", "drag e1->e5"]);
  });

  it("answers a prompt with the page's own default unless told otherwise", async () => {
    rig.page.dialog = { defaultPrompt: "guest" };
    await rig.call("browser_handle_dialog", { accept: true });
    await rig.call("browser_handle_dialog", { accept: true, prompt_text: "ada" });
    await rig.call("browser_handle_dialog", { accept: false });
    rig.page.dialog = null;
    await rig.call("browser_handle_dialog", { accept: true });
    assert.deepEqual(rig.page.calls, ["dialog true guest", "dialog true ada", "dialog false guest", "dialog true -"]);
  });

  it("delegates navigation, screenshots (with the thread), logs and tabs", async () => {
    assert.equal(await rig.call("browser_navigate", { url: "localhost:5173" }), "Loaded localhost:5173");
    assert.equal(await rig.call("browser_screenshot"), "shot for t1");
    assert.equal(await rig.call("browser_console", { lines: 5 }), "console log");
    assert.equal(await rig.call("browser_network"), "network log");
    assert.equal(await rig.call("browser_tabs", { action: "open", url: "http://x.test", tab_id: 3 }), "tabs open");
    assert.deepEqual(rig.host.tabCalls, [["open", "http://x.test", 3]]);
    assert.match(await rig.call("browser_tabs", { action: "explode" }), /^ERROR: action must be one of: list, open, switch, close/);
    assert.deepEqual(rig.page.calls, ["console 5", "network 40"]);
  });
});
