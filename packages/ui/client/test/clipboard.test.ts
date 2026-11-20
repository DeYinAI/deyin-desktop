/**
 * Clipboard bridge contract.
 *
 * The renderer must reach the system clipboard through the desktop host when it
 * is available, and only fall back to navigator.clipboard in the web build. The
 * distinction matters: the navigator API silently fails in a packaged Electron
 * build when the document is not focused, which showed up as "copy does
 * nothing". These tests pin the preference order and the failure reporting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readClipboardText, showContextMenu, writeClipboardText } from "../src/clipboard.js";

/** Minimal window/navigator stand-in; the module reads both at call time. */
function withHost(host: {
  clipboard?: { readText(): Promise<string>; writeText(text: string): Promise<boolean> };
  contextMenu?: { show(request: unknown): Promise<unknown> };
  navigatorClipboard?: { readText(): Promise<string>; writeText(text: string): Promise<void> };
}): () => void {
  // `navigator` is a getter-only global in Node, so it needs defineProperty.
  const define = (name: "window" | "navigator", value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    return () => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete (globalThis as Record<string, unknown>)[name];
    };
  };
  const restoreWindow = define("window", {
    deyin: { clipboard: host.clipboard, contextMenu: host.contextMenu },
  });
  const restoreNavigator = define("navigator", { clipboard: host.navigatorClipboard });
  return () => {
    restoreWindow();
    restoreNavigator();
  };
}

test("writeClipboardText prefers the host bridge over navigator.clipboard", async () => {
  const writes: string[] = [];
  let navigatorUsed = false;
  const restore = withHost({
    clipboard: {
      readText: async () => "",
      writeText: async (text) => {
        writes.push(text);
        return true;
      },
    },
    navigatorClipboard: {
      readText: async () => "",
      writeText: async () => {
        navigatorUsed = true;
      },
    },
  });
  try {
    assert.equal(await writeClipboardText("from bridge"), true);
    assert.deepEqual(writes, ["from bridge"]);
    assert.equal(navigatorUsed, false, "navigator.clipboard must not be touched when the bridge exists");
  } finally {
    restore();
  }
});

test("writeClipboardText falls back to navigator.clipboard in the web host", async () => {
  let written: string | null = null;
  const restore = withHost({
    navigatorClipboard: {
      readText: async () => "",
      writeText: async (text) => {
        written = text;
      },
    },
  });
  try {
    assert.equal(await writeClipboardText("from web"), true);
    assert.equal(written, "from web");
  } finally {
    restore();
  }
});

test("writeClipboardText reports failure instead of claiming a copy", async () => {
  const restore = withHost({
    navigatorClipboard: {
      readText: async () => "",
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  try {
    assert.equal(await writeClipboardText("nope"), false);
  } finally {
    restore();
  }
});

test("writeClipboardText reports a host refusal", async () => {
  const restore = withHost({
    clipboard: {
      readText: async () => "",
      writeText: async () => false,
    },
  });
  try {
    assert.equal(await writeClipboardText("nope"), false);
  } finally {
    restore();
  }
});

test("readClipboardText returns empty string when nothing can read it", async () => {
  const restore = withHost({});
  try {
    assert.equal(await readClipboardText(), "");
  } finally {
    restore();
  }
});

test("showContextMenu is a no-op in the browser host", async () => {
  const restore = withHost({});
  try {
    assert.equal(await showContextMenu({ kind: "text" }), null);
  } finally {
    restore();
  }
});

test("showContextMenu forwards the request and returns the chosen command", async () => {
  const requests: unknown[] = [];
  const restore = withHost({
    contextMenu: {
      show: async (request) => {
        requests.push(request);
        return "paste";
      },
    },
  });
  try {
    const command = await showContextMenu({ kind: "terminal", hasSelection: true, x: 10, y: 20 });
    assert.equal(command, "paste");
    assert.deepEqual(requests, [{ kind: "terminal", hasSelection: true, x: 10, y: 20 }]);
  } finally {
    restore();
  }
});

test("showContextMenu swallows a host error rather than breaking the click", async () => {
  const restore = withHost({
    contextMenu: {
      show: async () => {
        throw new Error("no window");
      },
    },
  });
  try {
    assert.equal(await showContextMenu({ kind: "text" }), null);
  } finally {
    restore();
  }
});
