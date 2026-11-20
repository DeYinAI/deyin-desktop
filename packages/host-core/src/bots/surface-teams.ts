import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { fitReply, SURFACE_LIMITS, type HttpFetch, type InboundMessage } from "./surfaces.js";

/**
 * Microsoft Teams, through the Bot Framework: Teams posts an activity to a URL the owner registers, signed with a
 * token Microsoft issues; the Bot answers by posting an activity back to the `serviceUrl` the request came with. The
 * shapes and the checks below are the documented ones for Bot Connector authentication.
 */

export const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";
export const BOT_FRAMEWORK_OPENID = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const TOKEN_SCOPE = "https://api.botframework.com/.default";
/** The skew Microsoft allows between its clock and ours. */
const SKEW_SECONDS = 5 * 60;

export interface BotFrameworkKey extends JsonWebKey {
  kid?: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function decodePart(part: string): Record<string, unknown> | null {
  try {
    return object(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function sameServiceUrl(a: string, b: string): boolean {
  const norm = (value: string): string => value.trim().replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export type TokenCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether a request's token is one Microsoft issued to this Bot for this very request: signed by one of its published
 * keys (RS256 only, so a token cannot choose a weaker algorithm), from the Bot Framework, for this app id, in date,
 * and naming the same service URL as the activity it came with.
 */
export function verifyBotFrameworkToken(
  token: string,
  expected: { appId: string; keys: readonly BotFrameworkKey[]; nowMs: number; serviceUrl: string },
): TokenCheck {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) return { ok: false, reason: "not a token" };
  const [head, body, signature] = parts as [string, string, string];
  const header = decodePart(head);
  const claims = decodePart(body);
  if (!header || !claims) return { ok: false, reason: "not a token" };
  if (header.alg !== "RS256") return { ok: false, reason: "wrong algorithm" };
  const kid = str(header.kid);
  const jwk = expected.keys.find((key) => key.kty === "RSA" && key.kid === kid);
  if (!kid || !jwk) return { ok: false, reason: "unknown key" };
  let valid: boolean;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    valid = verify("RSA-SHA256", Buffer.from(`${head}.${body}`), key, Buffer.from(signature, "base64url"));
  } catch {
    return { ok: false, reason: "bad key" };
  }
  if (!valid) return { ok: false, reason: "bad signature" };
  if (claims.iss !== BOT_FRAMEWORK_ISSUER) return { ok: false, reason: "wrong issuer" };
  if (claims.aud !== expected.appId) return { ok: false, reason: "wrong audience" };
  const now = expected.nowMs / 1000;
  if (typeof claims.exp !== "number" || claims.exp < now - SKEW_SECONDS) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf > now + SKEW_SECONDS) return { ok: false, reason: "not yet valid" };
  const claimed = str(claims.serviceurl);
  if (!claimed || !sameServiceUrl(claimed, expected.serviceUrl)) return { ok: false, reason: "service URL does not match" };
  return { ok: true };
}

/** The Bot Framework's published signing keys, kept for a day and fetched again once when a token names one we lack. */
export class BotFrameworkKeys {
  private cached: { keys: BotFrameworkKey[]; at: number } | null = null;
  private lastRefresh = 0;

  constructor(
    private readonly fetchImpl: HttpFetch,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = 24 * 60 * 60_000,
    private readonly cooldownMs: number = 60_000,
  ) {}

  private async load(): Promise<BotFrameworkKey[]> {
    const config = await this.fetchImpl(BOT_FRAMEWORK_OPENID);
    if (!config.ok) throw new Error(`Microsoft's key list could not be found (${config.status}).`);
    const uri = str(object(await config.json())?.jwks_uri);
    if (!uri || !uri.startsWith("https://")) throw new Error("Microsoft's key list was not where it said.");
    const response = await this.fetchImpl(uri);
    if (!response.ok) throw new Error(`Microsoft's keys could not be read (${response.status}).`);
    const list = object(await response.json())?.keys;
    if (!Array.isArray(list)) throw new Error("Microsoft's keys were not in the form expected.");
    const keys = list.filter((key): key is BotFrameworkKey => object(key) !== null);
    this.cached = { keys, at: this.now() };
    this.lastRefresh = this.now();
    return keys;
  }

  /** The keys to check a token against. `kid` is the key the token names; a key not seen yet triggers one fresh fetch. */
  async keysFor(kid: string | undefined): Promise<BotFrameworkKey[]> {
    const now = this.now();
    if (!this.cached || now - this.cached.at > this.ttlMs) return this.load();
    if (kid && !this.cached.keys.some((key) => key.kid === kid) && now - this.lastRefresh > this.cooldownMs) return this.load();
    return this.cached.keys;
  }
}

/** The key id a token names, read without trusting anything else in it. */
export function tokenKeyId(token: string): string | undefined {
  const head = token.split(".")[0];
  return head ? str(decodePart(head)?.kid) : undefined;
}

export interface TeamsTarget {
  serviceUrl: string;
  conversationId: string;
  activityId: string;
  /** The person, so the reply is addressed to them. */
  user: { id: string; name?: string };
  /** The Bot, as Teams addressed it. */
  bot: { id: string; name?: string };
}

export type TeamsActivity =
  | { kind: "message"; message: Omit<InboundMessage, "botId" | "surface" | "receivedAt">; target: TeamsTarget }
  | { kind: "ignore"; reason: string };

/** `<at>Name</at>` mentions are how a person addressed the Bot in a group, not what they asked. */
const AT_TAG = /<at>[^<]*<\/at>/gi;

/** What an activity from Teams means: a message is acted on, everything else (typing, updates, joins) is ignored. */
export function parseTeamsActivity(body: unknown): TeamsActivity {
  const activity = object(body);
  if (!activity) return { kind: "ignore", reason: "not an object" };
  if (activity.type !== "message") return { kind: "ignore", reason: "not a message" };
  const from = object(activity.from);
  const conversation = object(activity.conversation);
  const recipient = object(activity.recipient);
  const serviceUrl = str(activity.serviceUrl);
  const id = str(activity.id);
  const fromId = str(from?.id);
  const conversationId = str(conversation?.id);
  const botId = str(recipient?.id);
  if (!from || !fromId || !conversationId || !serviceUrl || !id || !botId) return { kind: "ignore", reason: "missing sender, conversation or address" };
  if (!serviceUrl.startsWith("https://")) return { kind: "ignore", reason: "service URL is not https" };
  const text = (typeof activity.text === "string" ? activity.text : "").replace(AT_TAG, "").replace(/\s+/g, " ").trim();
  if (text === "") return { kind: "ignore", reason: "empty" };
  const aad = str(from.aadObjectId);
  const name = str(from.name);
  return {
    kind: "message",
    target: {
      serviceUrl,
      conversationId,
      activityId: id,
      user: { id: fromId, ...(name ? { name } : {}) },
      bot: { id: botId, ...(str(recipient?.name) ? { name: str(recipient?.name) as string } : {}) },
    },
    message: {
      senderId: aad ?? fromId,
      senderAliases: aad ? [aad, fromId] : [fromId],
      senderLabel: name ? `${name} (Teams)` : `Teams user ${fromId}`,
      conversationKey: conversationId,
      deliveryId: `teams:${conversationId}:${id}`,
      text,
    },
  };
}

/** The activity that answers a message, addressed back to the person in the same conversation. */
export function teamsReplyActivity(target: TeamsTarget, reply: string): Record<string, unknown> {
  return {
    type: "message",
    text: fitReply(reply, SURFACE_LIMITS.replyChars),
    from: target.bot,
    recipient: target.user,
    conversation: { id: target.conversationId },
    replyToId: target.activityId,
  };
}

/** Where the reply is posted: under the service URL the signed request named, which is why that URL is checked first. */
export function teamsReplyUrl(target: TeamsTarget): string {
  const base = target.serviceUrl.replace(/\/+$/, "");
  return `${base}/v3/conversations/${encodeURIComponent(target.conversationId)}/activities/${encodeURIComponent(target.activityId)}`;
}

export function teamsTokenUrl(tenant: string | undefined): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant && tenant !== "" ? tenant : "botframework.com")}/oauth2/v2.0/token`;
}

export function teamsTokenBody(appId: string, appPassword: string): string {
  return new URLSearchParams({ grant_type: "client_credentials", client_id: appId, client_secret: appPassword, scope: TOKEN_SCOPE }).toString();
}

/** Answers for tokens Microsoft issued this Bot, kept until a minute before they run out. */
export class BotFrameworkTokens {
  private readonly cache = new Map<string, { token: string; until: number }>();

  constructor(
    private readonly fetchImpl: HttpFetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(input: { appId: string; appPassword: string; tenant?: string }): Promise<string> {
    const key = `${input.tenant ?? ""}\u0000${input.appId}`;
    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) return hit.token;
    const response = await this.fetchImpl(teamsTokenUrl(input.tenant), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: teamsTokenBody(input.appId, input.appPassword),
    });
    if (!response.ok) throw new Error(`Microsoft would not give this Bot a token (${response.status}). Check the app id, password and tenant.`);
    const body = object(await response.json());
    const token = str(body?.access_token);
    if (!token) throw new Error("Microsoft's answer had no token.");
    const lifetime = typeof body?.expires_in === "number" && body.expires_in > 120 ? body.expires_in : 300;
    this.cache.set(key, { token, until: this.now() + (lifetime - 60) * 1000 });
    return token;
  }
}
