/**
 * Which sites a Vault login may be used on. A login is saved for hosts (`github.com`), and it covers that
 * host and its subdomains (`login.github.com`) — never a host that merely contains the name
 * (`github.com.evil.example`, `evil-github.com`). Pure functions; no I/O.
 */

/**
 * Two-label public suffixes and shared hosting domains. A login saved for one of these would cover every
 * unrelated site under it, so none can be saved. This is a short list of the common ones, not the full
 * Public Suffix List.
 */
const SHARED_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "net.nz", "govt.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "com.cn", "net.cn", "org.cn", "gov.cn",
  "com.hk", "com.tw", "com.sg", "com.my", "com.ph", "com.vn",
  "com.br", "net.br", "org.br", "com.ar", "com.mx", "com.co", "com.pe",
  "com.tr", "com.ua", "co.in", "net.in", "org.in", "firm.in", "gen.in",
  "co.za", "org.za", "co.il", "co.id", "or.id", "com.sa", "com.eg", "com.ng", "co.ke",
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app",
  "herokuapp.com", "blogspot.com", "appspot.com", "cloudfront.net", "azurewebsites.net",
  "web.app", "firebaseapp.com", "s3.amazonaws.com", "amazonaws.com", "onrender.com", "fly.dev",
]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const MAX_HOST = 253;
const MAX_INPUT = 2048;

export function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function isIpHost(host: string): boolean {
  return IPV4.test(host) || host.startsWith("[");
}

function isAcceptableHost(host: string): boolean {
  if (!host || host.length > MAX_HOST) return false;
  if (isLocalHost(host)) return true;
  if (IPV4.test(host)) return true;
  if (host.startsWith("[")) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => LABEL.test(label))) return false;
  return !SHARED_SUFFIXES.has(host);
}

/**
 * The host a person means by `github.com`, `https://github.com/login` or `login.github.com:443`, or null when it
 * is not a host a login can be saved for (not a web address, carries a password, one label, a shared suffix).
 */
export function normalizeSite(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let text = input.trim().toLowerCase();
  if (!text || text.length > MAX_INPUT) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.replace(/\.$/, "");
  return isAcceptableHost(host) ? host : null;
}

/**
 * The host of a page address, only when typing a credential into it is reasonable: https anywhere, plain http
 * only on this machine. A page address with a username or password in it, or any other kind of address, gives null.
 */
export function pageHost(address: string): string | null {
  if (typeof address !== "string" || address.length > MAX_INPUT * 4) return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (!host) return null;
  if (url.protocol === "https:") return host;
  if (url.protocol === "http:" && isLocalHost(host)) return host;
  return null;
}

/** Whether a saved site covers a page host: the same host, or a subdomain of it. Addresses and localhost match only themselves. */
export function siteCovers(site: string, host: string): boolean {
  if (site === host) return true;
  if (isIpHost(site) || isIpHost(host) || isLocalHost(site)) return false;
  return host.endsWith(`.${site}`);
}

/** The saved site that covers the page at `address`, or null when none does (or the page is not one to fill). */
export function matchingSite(sites: readonly string[], address: string): string | null {
  const host = pageHost(address);
  if (!host) return null;
  return sites.find((site) => siteCovers(site, host)) ?? null;
}
