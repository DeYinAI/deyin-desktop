/**
 * One-shot service worker that replaces the legacy Openference Chat Workbox SW,
 * clears precached assets, reloads tabs, then unregisters itself.
 */
const LEGACY_SW_KILL = String.raw`self.addEventListener("install",()=>{self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil((async()=>{const ks=await caches.keys();await Promise.all(ks.map(k=>caches.delete(k)));const cs=await self.clients.matchAll({type:"window"});await Promise.all(cs.map(c=>c.navigate(c.url)));await self.registration.unregister()})())});`;

const LEGACY_PWA_PREFIXES = ["/sw.js", "/dev-sw.js", "/registerSW.js", "/workbox-"];

export function isLegacyPwaAssetPath(pathname: string): boolean {
  return LEGACY_PWA_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export function legacySwKillResponse(): Response {
  return new Response(LEGACY_SW_KILL, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });
}

/** Strip legacy PWA storage when a fresh document reaches the browser (one-shot /migrate only). */
export function withLegacyPwaClearHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("clear-site-data", '"cache", "storage", "executionContexts"');
  headers.set("cache-control", "no-store, no-cache, must-revalidate");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
