import type { ChromeBridgeStatus } from "@deyin/contract";

export type Headline = { tone: "ok" | "warn" | "bad" | "muted"; text: string; detail?: string };

/** "123456" → "123 456", easier to compare against the extension popup by eye. */
export function groupCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** One honest sentence about where the Chrome connection stands. */
export function connectionHeadline(status: ChromeBridgeStatus): Headline {
  if (!status.listening) {
    return {
      tone: "bad",
      text: "Deyin could not start its local connection.",
      detail: status.error ?? "Another app may be using ports 9410–9414.",
    };
  }
  if (status.stopped) {
    return {
      tone: "warn",
      text: "Stopped. Deyin will not touch Chrome until you resume.",
      ...(status.error ? { detail: status.error } : {}),
    };
  }
  switch (status.connection) {
    case "connected":
      return { tone: "ok", text: `Connected to ${status.browser?.label ?? "Chrome"}.` };
    case "pairing":
      return status.pairingCode
        ? { tone: "warn", text: "Compare this code with the one in the Deyin extension popup." }
        : { tone: "warn", text: "Waiting for the extension. Click the Deyin icon in Chrome's toolbar." };
    case "disconnected": {
      const first = status.pairedBrowsers[0];
      return first
        ? { tone: "muted", text: `Paired with ${first.label}. Open Chrome with the Deyin extension enabled; it reconnects on its own.` }
        : { tone: "muted", text: "Not paired yet. Install the extension below, then choose Pair Chrome." };
    }
    default: {
      const _exhaustive: never = status.connection;
      return { tone: "muted", text: String(_exhaustive) };
    }
  }
}

export type OriginResult = { ok: true; origin: string } | { ok: false; error: string };

/** Turn what the user typed ("example.com", "http://localhost:3000/x") into an approvable origin. */
export function normalizeApprovedOrigin(raw: string): OriginResult {
  const text = raw.trim();
  if (!text) return { ok: false, error: "Enter a site like https://example.com." };
  let origin: string;
  try {
    origin = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`).origin;
  } catch {
    return { ok: false, error: "Enter a site like https://example.com." };
  }
  if (!/^https?:\/\//.test(origin)) return { ok: false, error: "Only http and https sites can be approved." };
  return { ok: true, origin };
}

/** What the agent is about to do, in the words the approval dialog uses. */
export function originActionVerb(action: string): string {
  switch (action) {
    case "open":
      return "open";
    case "navigate":
      return "go to";
    default:
      return "use";
  }
}
