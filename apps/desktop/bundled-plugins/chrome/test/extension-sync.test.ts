import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCKED_SCHEMES, DEYIN_EXTENSION_ID, PROTOCOL_VERSION, RELAY_PORTS, classifyUrl } from "../host/chrome-protocol.js";

/**
 * The extension is plain JS with hand-mirrored constants. These tests fail
 * when the extension and the host drift apart.
 */

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "extension");
const browserHostDir = join(here, "..", "..", "browser", "host");
const worker = readFileSync(join(extensionDir, "service-worker.js"), "utf8");
const cdpPage = readFileSync(join(browserHostDir, "cdp-page.ts"), "utf8");
const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8")) as {
  key: string;
  permissions: string[];
  host_permissions?: unknown;
  content_scripts?: unknown;
  background: { service_worker: string };
  action: { default_popup: string };
};

function setLiterals(source: string, name: string): string[] {
  const match = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(source);
  assert.ok(match?.[1], `${name} not found`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

describe("extension identity", () => {
  it("manifest key derives the extension id the relay pins", () => {
    const der = Buffer.from(manifest.key, "base64");
    const id = [...createHash("sha256").update(der).digest().subarray(0, 16).toString("hex")]
      .map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
      .join("");
    assert.equal(id, DEYIN_EXTENSION_ID);
  });

  it("requests only the permissions it needs and no page access", () => {
    assert.deepEqual([...manifest.permissions].sort(), ["alarms", "debugger", "storage", "tabGroups", "tabs"]);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.content_scripts, undefined);
  });

  it("ships the files the manifest references", () => {
    for (const file of [manifest.background.service_worker, manifest.action.default_popup, "popup.js", "popup.css"]) {
      assert.doesNotThrow(() => readFileSync(join(extensionDir, file)), file);
    }
  });
});

describe("extension mirrors of host constants", () => {
  it("uses the same protocol version and ports", () => {
    assert.equal(Number(/const PROTOCOL_VERSION = (\d+);/.exec(worker)?.[1]), PROTOCOL_VERSION);
    const ports = /const PORTS = \[([^\]]+)\]/.exec(worker)?.[1]?.split(",").map((p) => Number(p.trim()));
    assert.deepEqual(ports, [...RELAY_PORTS]);
  });

  it("blocks the same URL schemes as the host", () => {
    assert.deepEqual(setLiterals(worker, "BLOCKED_SCHEMES").sort(), [...BLOCKED_SCHEMES].sort());
    for (const url of ["chrome://settings", "chrome-extension://abc/page.html", "devtools://devtools/x", "view-source:https://a.test", "about:config"]) {
      assert.equal(classifyUrl(url).ok, false, url);
    }
  });

  it("allows every CDP method the shared page layer calls, and forwards every event it subscribes to", () => {
    const allowed = new Set(setLiterals(worker, "CDP_ALLOWED"));
    const forwarded = new Set(setLiterals(worker, "EVENTS_FORWARDED"));

    const events = [...cdpPage.matchAll(/\.on\(\s*"([A-Z][A-Za-z]+\.[A-Za-z]+)"/g)].map((m) => m[1] as string);
    assert.ok(events.length >= 8, "expected to find the event subscriptions");
    for (const event of events) assert.ok(forwarded.has(event), `event not forwarded by the extension: ${event}`);

    const methods = new Set(
      [...cdpPage.matchAll(/"([A-Z][A-Za-z]+\.[a-z][A-Za-z]+)"/g)].map((m) => m[1] as string).filter((m) => !events.includes(m)),
    );
    for (const method of methods) assert.ok(allowed.has(method), `CDP method used by cdp-page.ts but not allowed by the extension: ${method}`);
  });

  it("never allows cookie, storage, target or browser-level CDP access", () => {
    const allowed = setLiterals(worker, "CDP_ALLOWED");
    for (const method of allowed) {
      assert.ok(!/^(Browser|Target|Storage|Fetch|IO|SystemInfo|Security|Extensions)\./.test(method), method);
      assert.ok(!/cookie/i.test(method), method);
    }
  });
});
