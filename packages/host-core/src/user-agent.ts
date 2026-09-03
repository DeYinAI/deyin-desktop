/**
 * Single source of truth for the User-Agent Deyin sends on every outbound HTTP
 * request: LLM providers, web search, GitHub, and the Openference APIs.
 *
 * Format follows the standard `product/version (comment)` convention:
 *
 *   Deyin/1.0.15 (desktop; Windows; node/22.10)
 *
 * The surface and version are supplied once at app startup via `initUserAgent`
 * (desktop: `app.getVersion()`, CLI: the package version, web host-server: the
 * package.json version); platform and runtime come from the ambient process.
 *
 * Pure string building with no `node:` imports: host-core's `/shared` surface
 * (which re-exports this module) is bundled into the desktop renderer and the
 * web client, where `process` may not exist.
 */

export type DeyinAppSurface = "desktop" | "cli" | "web-server" | "unknown";

let current = "";

/** Platform comment token for the running OS; "browser" without a process. */
function platformToken(): string {
 if (typeof process === "undefined") return "browser";
 switch (process.platform) {
 case "win32":
 return "Windows";
 case "darwin":
 return "macOS";
 default:
 return "Linux";
 }
}

/** Runtime comment token: the Node major.minor, or "browser" without a process. */
function runtimeToken(): string {
 if (typeof process === "undefined") return "browser";
 const node = (process.versions as Record<string, string | undefined> | undefined)?.node;
 if (!node) return "browser";
 return `node/${node.split(".").slice(0, 2).join(".")}`;
}

/** Build the canonical UA string without storing it (also used by the fallback). */
export function buildDeyinUserAgent(app: DeyinAppSurface, version: string): string {
 return `Deyin/${version} (${app}; ${platformToken()}; ${runtimeToken()})`;
}

/**
 * Store the process-wide User-Agent. Call once at app startup, before any
 * outbound request. Returns the stored UA for convenience.
 */
export function initUserAgent(app: Exclude<DeyinAppSurface, "unknown">, version: string): string {
 current = buildDeyinUserAgent(app, version);
 return current;
}

/**
 * The User-Agent for outbound requests. Returns the value stored by
 * `initUserAgent`; when startup wiring was missed, builds a distinctive
 * `Deyin/0.0.0 (unknown; …)` fallback — deliberately greppable in server logs,
 * never an empty header.
 */
export function deyinUserAgent(): string {
 if (current) return current;
 return buildDeyinUserAgent("unknown", "0.0.0");
}

/** Test hook: restore the uninitialized state. */
export function resetUserAgentForTest(): void {
 current = "";
}
