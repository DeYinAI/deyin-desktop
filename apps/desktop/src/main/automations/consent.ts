import type { ToolDefinition } from "@deyin/agent-core";
import type { Automation, AutomationBlocker, AutomationResource } from "@deyin/host-core";
import { originOfUrl } from "../chrome-origins.js";

/**
 * What an unattended automation may do in the user's browser.
 *
 * Chrome is the user's own, signed-in browser: a click there acts as the user.
 * Interactively the user answers a prompt the first time a site is touched; an
 * unattended run has nobody to ask, so it used to be refused outright — and an
 * automation that needed the browser improvised around the refusal. Instead the
 * user grants consent up front, per site, on the automation itself, and this
 * guard holds each run to it. Pure of Electron; the Chrome service is reached
 * only through the narrow readiness input below.
 */

/* Threads ----------------------------------------------------------------------------------- */

const THREAD_PREFIX = "automation-";

/**
 * The thread id an automation's tool calls carry. It keeps one automation's Chrome tabs apart from
 * every other run's, and lets the host tell an unattended caller from a person.
 */
export function automationThreadId(automationId: string): string {
  return `${THREAD_PREFIX}${automationId}`;
}

export function isAutomationThread(threadId: string | undefined): boolean {
  return typeof threadId === "string" && threadId.startsWith(THREAD_PREFIX);
}

/* Origins ----------------------------------------------------------------------------------- */

/**
 * "x.com" or "https://x.com/home" → "https://x.com"; null when it is not a site. Stricter than Chrome's own helper,
 * because this is what a grant is made of: only http(s) is a site, and a bare word is a typo until it is written
 * as a full origin (so `http://intranet` is accepted and `intranet` is not).
 */
export function normalizeOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const explicit = /^https?:\/\//i.test(trimmed);
  if (!explicit) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^(javascript|data|file|about|chrome|blob|mailto):/i.test(trimmed)) return null;
    const host = trimmed.split(/[/?#]/, 1)[0] ?? "";
    if (!host.includes(".") && !/^localhost(:\d+)?$/i.test(host) && !host.startsWith("[")) return null;
  }
  const origin = originOfUrl(trimmed);
  return origin && origin !== "null" ? origin : null;
}

/** The sites an automation has consent for, normalized and de-duplicated. Unusable entries are dropped. */
export function consentOrigins(automation: Pick<Automation, "consent">): string[] {
  const out: string[] = [];
  for (const raw of automation.consent?.browserOrigins ?? []) {
    const origin = normalizeOrigin(raw);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/** What is wrong with consent a person or agent supplied, or null when every entry is a site. */
export function consentError(origins: readonly string[] | undefined): string | null {
  for (const raw of origins ?? []) {
    if (typeof raw !== "string" || normalizeOrigin(raw) === null) return `"${String(raw)}" is not a site. Use an origin such as https://x.com.`;
  }
  return null;
}

/* The guard --------------------------------------------------------------------------------- */

/** The tool families that act in a browser. `browser_*` is the in-app browser; MCP browsers are matched by name. */
function browserFamily(tool: string): "chrome" | "other" | null {
  if (tool.startsWith("chrome_")) return "chrome";
  if (tool.startsWith("browser_") || /^mcp__.*(browser|playwright|puppeteer|chrome)/i.test(tool)) return "other";
  return null;
}

/** Every URL-looking argument, looked for where a tool takes one (`url`, `href`), a few levels in. */
function urlsIn(value: unknown, depth = 0): string[] {
  if (depth > 3 || value === null || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "url" || key === "href") && typeof inner === "string" && inner.trim()) found.push(inner);
    else found.push(...urlsIn(inner, depth + 1));
  }
  return found;
}

export type ConsentVerdict = { allow: true } | { allow: false; reason: string };

/**
 * Whether an unattended run may make this browser call. Chrome tools need consent; other browser
 * tools are held to it only when the automation declared any (so an automation that never
 * mentioned browsing keeps working as before). Not a sandbox — it scopes where the agent may be
 * *sent*; where a page then links to is for Chrome's own per-origin approval, which an unattended
 * run cannot answer and so is refused.
 */
export function checkBrowserCall(tool: string, args: Record<string, unknown>, origins: readonly string[]): ConsentVerdict {
  const family = browserFamily(tool);
  if (!family) return { allow: true };
  if (origins.length === 0) {
    return family === "chrome"
      ? { allow: false, reason: `${tool} is refused: this automation has no browser consent. Report blocked with blocker kind approval-required instead of working around it.` }
      : { allow: true };
  }
  for (const url of urlsIn(args)) {
    const origin = normalizeOrigin(url);
    if (origin === null) return { allow: false, reason: `${tool} is refused: "${url}" is not a URL this automation can open.` };
    if (!origins.includes(origin)) {
      return {
        allow: false,
        reason: `${tool} is refused: ${origin} is not in this automation's browser consent (allowed: ${origins.join(", ")}). Do not go there; if the task needs it, report blocked with blocker kind approval-required.`,
      };
    }
  }
  return { allow: true };
}

/* Resources --------------------------------------------------------------------------------- */

/**
 * What a run holds exclusively. Two runs steering the same Chrome would fight over its tabs and
 * focus, so a run that uses the browser holds `browser` and a second one waits its turn.
 */
export function resourcesOf(automation: Pick<Automation, "requires" | "consent">): AutomationResource[] {
  const held = new Set<AutomationResource>(automation.requires?.exclusive ?? []);
  if (consentOrigins(automation).length > 0) held.add("browser");
  return [...held];
}

/* Chrome readiness -------------------------------------------------------------------------- */

/** What the Chrome service reports, narrowed to what a preflight needs. */
export interface BrowserReadiness {
  enabled: boolean;
  connection: "disconnected" | "pairing" | "connected";
  stopped: boolean;
  /** Origins the user has approved for Chrome control, app-wide. */
  approvedOrigins: readonly string[];
}

/** The Chrome service, narrowed to what an unattended run needs from it. */
export interface ChromeAutomationPort {
  tools(): ToolDefinition[];
  status(): { enabled: boolean; connection: "disconnected" | "pairing" | "connected"; stopped: boolean };
  getApprovedOrigins(): string[];
}

/** What a preflight needs to know about Chrome, or undefined when this host has none. */
export function browserReadiness(chrome: ChromeAutomationPort | undefined): BrowserReadiness | undefined {
  if (!chrome) return undefined;
  const status = chrome.status();
  return { enabled: status.enabled, connection: status.connection, stopped: status.stopped, approvedOrigins: chrome.getApprovedOrigins() };
}

/** Whether the automation will use Chrome: it has consent for sites, or requires a `chrome_*` tool. */
export function needsChrome(automation: Pick<Automation, "requires" | "consent">): boolean {
  if (consentOrigins(automation).length > 0) return true;
  return (automation.requires?.tools ?? []).some((pattern) => pattern.startsWith("chrome_") || pattern === "chrome*");
}

/**
 * Why Chrome cannot be driven right now, as a blocker; null when it can. Checked before any model is
 * called: a signed-out browser or an unapproved site is a thirty-second fix for a person, and a run that
 * discovers it halfway through has already cost a model session and may have improvised.
 */
export function chromeReadiness(origins: readonly string[], state: BrowserReadiness): AutomationBlocker | null {
  if (!state.enabled) return { kind: "tool-missing", detail: "Chrome control is turned off. Turn it on in Settings, then resume this automation." };
  if (state.stopped) return { kind: "stopped", detail: "Chrome control was stopped. Resume it from the Chrome control bar, then resume this automation." };
  if (state.connection !== "connected") return { kind: "tool-missing", detail: "Deyin is not connected to Chrome: the extension is not running or not paired." };
  const missing = origins.filter((origin) => !state.approvedOrigins.includes(origin));
  if (missing.length > 0) {
    return {
      kind: "approval-required",
      detail: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not approved for Chrome control yet. Approve ${missing.length === 1 ? "it" : "them"} once in Settings (or by asking the agent to open ${missing.length === 1 ? "it" : "them"} in a chat), then resume this automation.`,
    };
  }
  return null;
}
