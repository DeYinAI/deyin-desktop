/**
 * GitHub's OAuth device flow, for connecting the agent's account without anyone typing a token: the app asks GitHub for a short
 * code, the person enters it at github.com while signed in as the agent account, and the app collects the token GitHub then issues.
 *
 * It needs only a public client id (no secret). The id comes from a GitHub OAuth app with "Enable Device Flow" ticked; without one
 * the flow reports itself unavailable and setup falls back to pasting a token into the dashboard.
 *
 * The token goes from GitHub to the caller and nowhere else: it is not logged and no error message contains it.
 */
import { UserError, type FetchLike } from "@deyin/superagent";

const CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** The narrowest classic scope that lets an account push branches and open pull requests, private repositories included. */
export const DEVICE_FLOW_SCOPE = "repo";
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_STEP_SECONDS = 5;
const DEFAULT_BUDGET_MS = 30_000;

/** The id of Deyin's GitHub OAuth app. Public by design: the device flow has no client secret. Empty until the app is registered. */
const BUNDLED_CLIENT_ID = "";

/** The client id to use; `DEYIN_GITHUB_CLIENT_ID` overrides the bundled one, for forks and development. */
export function githubClientId(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.DEYIN_GITHUB_CLIENT_ID?.trim() || BUNDLED_CLIENT_ID;
}

/** What the person does in their browser to approve. The code is meant to be shown on screen. */
export interface DeviceAuthorization {
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
}

export interface DeviceFlowPort {
  readonly available: boolean;
  begin(): Promise<DeviceAuthorization>;
  /** The token once the person approved; `undefined` while they have not. Throws when the request was denied, expired or refused. */
  finish(): Promise<string | undefined>;
}

export interface DeviceFlowOptions {
  clientId: string;
  fetch: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long one `finish` keeps polling while GitHub says the approval has not arrived yet. */
  budgetMs?: number;
}

interface Pending {
  deviceCode: string;
  expiresAt: number;
  intervalSeconds: number;
  /** GitHub answers `slow_down` to a poll that comes sooner than the interval, so the next one waits for this. */
  nextPollAt: number;
}

type Answer = Readonly<Record<string, unknown>>;

function text(answer: Answer, key: string): string | undefined {
  const value = answer[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function seconds(answer: Answer, key: string): number | undefined {
  const value = answer[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class GithubDeviceFlow implements DeviceFlowPort {
  private pending: Pending | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: DeviceFlowOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
  }

  get available(): boolean {
    return this.options.clientId.trim() !== "";
  }

  /** Asks GitHub for a code. Starting again replaces an earlier, unfinished request. */
  async begin(): Promise<DeviceAuthorization> {
    if (!this.available) throw new UserError("setup", "Signing in with GitHub is not set up in this build");
    const answer = await this.post(CODE_URL, { client_id: this.options.clientId, scope: DEVICE_FLOW_SCOPE });
    const deviceCode = text(answer, "device_code");
    const userCode = text(answer, "user_code");
    const verificationUri = text(answer, "verification_uri");
    if (!deviceCode || !userCode || !verificationUri) throw this.refusal(answer);
    const expiresInSeconds = seconds(answer, "expires_in") ?? 900;
    const intervalSeconds = seconds(answer, "interval") ?? DEFAULT_INTERVAL_SECONDS;
    const now = this.now();
    this.pending = { deviceCode, expiresAt: now + expiresInSeconds * 1000, intervalSeconds, nextPollAt: now + intervalSeconds * 1000 };
    return { userCode, verificationUri, expiresInSeconds };
  }

  async finish(): Promise<string | undefined> {
    const flow = this.pending;
    if (!flow) throw new UserError("setup", "No GitHub sign-in is waiting; start one first");
    const deadline = Math.min(flow.expiresAt, this.now() + (this.options.budgetMs ?? DEFAULT_BUDGET_MS));
    for (;;) {
      if (this.now() >= flow.expiresAt) return this.expire();
      const wait = flow.nextPollAt - this.now();
      if (wait > 0) {
        // Waiting for the interval would run past the budget: say "not yet" now and let the caller come back.
        if (this.now() + wait > deadline) return undefined;
        await this.sleep(wait);
      }
      const token = await this.poll(flow);
      if (token !== undefined) {
        this.pending = undefined;
        return token;
      }
    }
  }

  /** One exchange: the token when approved, `undefined` when GitHub is still waiting; anything final throws and ends the request. */
  private async poll(flow: Pending): Promise<string | undefined> {
    const answer = await this.post(TOKEN_URL, { client_id: this.options.clientId, device_code: flow.deviceCode, grant_type: GRANT_TYPE });
    flow.nextPollAt = this.now() + flow.intervalSeconds * 1000;
    const token = text(answer, "access_token");
    if (token) return token;
    const error = text(answer, "error");
    switch (error) {
      case "authorization_pending":
        return undefined;
      case "slow_down":
        // GitHub names the new interval; when it does not, the documented step is five seconds more.
        flow.intervalSeconds = seconds(answer, "interval") ?? flow.intervalSeconds + SLOW_DOWN_STEP_SECONDS;
        flow.nextPollAt = this.now() + flow.intervalSeconds * 1000;
        return undefined;
      case "expired_token":
        return this.expire();
      case "access_denied":
        this.pending = undefined;
        throw new UserError("invalid", "The sign-in was declined on GitHub. Start again if that was a mistake");
      default:
        this.pending = undefined;
        throw this.refusal(answer);
    }
  }

  private expire(): never {
    this.pending = undefined;
    throw new UserError("invalid", "The sign-in code expired before it was approved. Start again for a new code");
  }

  /** GitHub's own words for why it refused, or a plain fallback; never the body of the answer. */
  private refusal(answer: Answer): UserError {
    if (text(answer, "error") === "device_flow_disabled") {
      return new UserError("setup", "Device Flow is not enabled on Deyin's GitHub OAuth app. Paste a token into the dashboard instead");
    }
    const reason = text(answer, "error_description") ?? text(answer, "error");
    return new UserError("invalid", reason ? `GitHub refused the sign-in: ${reason}` : "GitHub sent an answer that was not understood");
  }

  private async post(url: string, form: Record<string, string>): Promise<Answer> {
    let body: string;
    try {
      const response = await this.options.fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      });
      body = await response.text();
    } catch (error) {
      throw new UserError("invalid", `Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Answer;
    } catch {
      // Falls through: an answer that is not JSON is as unusable as one that is not an object.
    }
    throw new UserError("invalid", "GitHub sent an answer that was not understood");
  }
}
