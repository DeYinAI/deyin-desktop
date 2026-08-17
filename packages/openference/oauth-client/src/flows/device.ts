import type { OAuthClient } from "../client.js";
import { openBrowser } from "../util/open-browser.js";
import { OAuthClientError, type TokenSet } from "../types.js";

export interface DeviceAuthorization {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceLoginOptions {
  /** Called once with the user_code + verification URL so a CLI can print instructions. */
  onAuthorization?: (info: DeviceAuthorization) => void;
  /** Open the verification URL in the browser (default false; CLIs usually just print it). */
  open?: boolean;
  /** Abort the polling loop. */
  signal?: AbortSignal;
}

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new OAuthClientError("Aborted.", "aborted"));
    });
  });

/**
 * Device Authorization Grant (RFC 8628) for headless / SSH logins. Starts the flow,
 * surfaces the user code, then polls until the user approves on another device.
 */
export async function loginWithDevice(
  client: OAuthClient,
  options: DeviceLoginOptions = {},
): Promise<TokenSet> {
  const endpoints = await client.getEndpoints();
  const doFetch = client.config.fetch ?? fetch;

  const startRes = await doFetch(endpoints.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.config.clientId,
      scope: client.config.scopes.join(" "),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!startRes.ok) {
    throw new OAuthClientError(`Device authorization failed: HTTP ${startRes.status}`, "device_start_failed");
  }
  const start = (await startRes.json()) as DeviceAuthResponse;

  options.onAuthorization?.({
    userCode: start.user_code,
    verificationUri: start.verification_uri,
    verificationUriComplete: start.verification_uri_complete,
    expiresIn: start.expires_in,
    interval: start.interval,
  });
  if (options.open && start.verification_uri_complete) openBrowser(start.verification_uri_complete);

  let interval = Math.max(start.interval, 1) * 1000;
  const deadline = Date.now() + start.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(interval, options.signal);
    try {
      return await client.exchangeDeviceCode(start.device_code);
    } catch (err) {
      const code = err instanceof OAuthClientError ? err.code : "";
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        interval += 5_000;
        continue;
      }
      throw err; // access_denied, expired_token, etc.
    }
  }
  throw new OAuthClientError("Device code expired before approval.", "expired_token");
}
