/** Chrome origin consent helpers. */

export function originOfUrl(url: string): string | null {
  try {
    const parsed = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`);
    return parsed.origin;
  } catch {
    return null;
  }
}

export function chromeOriginRequiresConsent(url: string, approved: Set<string>): boolean {
  const origin = originOfUrl(url);
  if (!origin) return true;
  if (origin === "about:blank") return false;
  return !approved.has(origin);
}
