import { createHash } from "node:crypto";

/**
 * Wire protocol between Deyin (relay server in Electron main) and the Deyin
 * Chrome extension (MV3 service worker). Every frame is one JSON object.
 *
 * Shape, borrowed from Browser MCP: the extension is a thin `chrome.debugger`
 * relay that connects out to a loopback WebSocket; all automation logic lives
 * in Deyin. The extension enforces its own rules (pairing, blocked pages,
 * Stop) no matter what the host asks.
 *
 * The extension is plain JS (it loads unpacked, no build step), so these types
 * are mirrored by hand in `extension/service-worker.js`. Bump
 * PROTOCOL_VERSION when either side changes incompatibly.
 */

export const PROTOCOL_VERSION = 1;

/** Ports the relay tries, in order. The extension tries the same list. */
export const RELAY_PORTS = [9410, 9411, 9412, 9413, 9414] as const;

/** WebSocket path the extension connects to. */
export const EXTENSION_PATH = "/extension";

/**
 * Id Chrome derives from the `key` in extension/manifest.json. The relay only
 * accepts WebSocket upgrades whose Origin is `chrome-extension://<this id>`.
 * Keep in sync with the manifest key (see extension/README.md).
 */
export const DEYIN_EXTENSION_ID = "oaabakimnaidjlcjoogjdpkpodjkcbfp";

/** Extra extension ids (e.g. a Web Store build) the relay accepts, comma separated. */
export const EXTRA_EXTENSION_IDS_ENV = "DEYIN_CHROME_EXTENSION_IDS";

/** How long a "Pair Chrome" window stays open. */
export const PAIRING_WINDOW_MS = 2 * 60 * 1000;

export const GROUP_TITLE = "Deyin";

/** One tab as reported by the extension. */
export interface ExtTab {
  id: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  incognito: boolean;
  /** Opened by the agent (lives in the Deyin group / window). */
  agent: boolean;
  /** The user shared this tab with Deyin from the extension popup. */
  shared: boolean;
  /** Debugger currently attached by Deyin. */
  attached: boolean;
}

/** Messages the extension sends to Deyin. */
export type ExtensionMessage =
  | {
      type: "hello";
      v: number;
      browserId: string;
      label: string;
      userAgent: string;
      extVersion: string;
      /** Token issued at pairing time for this host, when the extension has one. */
      pairToken?: string;
    }
  | { type: "pairingNonce"; nonce: string }
  | { type: "paired" }
  | { type: "state"; stopped: boolean; tabs: ExtTab[] }
  | { type: "tabEvent"; kind: "created" | "updated" | "removed" | "shared" | "unshared"; tab?: ExtTab; tabId: number }
  | { type: "event"; tabId: number; method: string; params: unknown }
  | { type: "detached"; tabId: number; reason: string }
  | { type: "stopped"; stopped: boolean }
  | { type: "response"; id: number; ok: true; value: unknown }
  | { type: "response"; id: number; ok: false; error: string }
  | { type: "pong" };

/** Messages Deyin sends to the extension. */
export type HostMessage =
  | { type: "welcome"; v: number; hostId: string; commit: string; paired: boolean; pairing: boolean }
  | { type: "pairingReveal"; nonce: string }
  | { type: "pairToken"; token: string }
  | { type: "rejected"; reason: "not_pairing" | "unsupported_protocol" | "origin" | "token" }
  | { type: "request"; id: number; op: HostOp; args: Record<string, unknown> }
  | { type: "ping" };

export type HostOp =
  | "tabs.list"
  | "tabs.create"
  | "tabs.close"
  | "tabs.reveal"
  | "debugger.attach"
  | "debugger.detach"
  | "cdp"
  | "control.stop"
  | "control.resume";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Six-digit code both sides derive from the two nonces. The host commits to
 * its nonce first (`welcome.commit`) and reveals it only after the extension's
 * nonce arrives, so neither side can steer the code.
 */
export function pairingCode(hostNonce: string, extensionNonce: string): string {
  const digest = createHash("sha256").update(`${hostNonce}|${extensionNonce}`).digest();
  const n = digest.readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, "0");
}

/** Origins and schemes the extension and the host both refuse to automate. */
export const BLOCKED_SCHEMES = new Set([
  "chrome:",
  "chrome-extension:",
  "chrome-untrusted:",
  "chrome-search:",
  "edge:",
  "devtools:",
  "view-source:",
  "javascript:",
]);

export type UrlVerdict = { ok: true; origin: string | null } | { ok: false; reason: string };

/**
 * Whether the agent may open or drive this URL. `origin` is null for
 * about:blank, which is always allowed and needs no approval.
 */
export function classifyUrl(raw: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `Not a valid URL: ${raw}` };
  }
  if (url.protocol === "about:") {
    return url.href === "about:blank" ? { ok: true, origin: null } : { ok: false, reason: `Blocked page: ${url.href}` };
  }
  if (BLOCKED_SCHEMES.has(url.protocol)) {
    return { ok: false, reason: `Blocked page type (${url.protocol}). Chrome internal pages and extensions cannot be automated.` };
  }
  if (url.protocol === "data:") return { ok: true, origin: null };
  if (url.protocol === "file:") return { ok: true, origin: "file://" };
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `Unsupported URL scheme: ${url.protocol}` };
  }
  return { ok: true, origin: url.origin };
}

/** localhost-style origins never need a first-use approval. */
export function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}
