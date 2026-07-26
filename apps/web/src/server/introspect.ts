export interface IntrospectionResult {
  active: boolean;
  sub?: string;
  scope?: string;
  plan?: string;
}

/**
 * Validate an access token against the Openference OAuth provider's introspection
 * endpoint before opening a host session. Fails closed.
 */
export async function introspect(issuer: string, token: string): Promise<IntrospectionResult> {
  try {
    const res = await fetch(`${issuer.replace(/\/+$/, "")}/oauth/introspect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    if (!res.ok) return { active: false };
    return (await res.json()) as IntrospectionResult;
  } catch {
    return { active: false };
  }
}
