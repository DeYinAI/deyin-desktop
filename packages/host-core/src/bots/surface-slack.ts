import { fitReply, SURFACE_LIMITS, type InboundMessage } from "./surfaces.js";
import { hmacSha256Hex, safeEqual } from "./surface-verify.js";

/**
 * Slack, through its Events API: Slack posts a signed request to a URL the owner gives it, and the Bot answers with
 * `chat.postMessage` in the same thread. The shapes below are Slack's documented ones.
 */

/** Slack's own allowance for how old a signed request may be. */
export const SLACK_MAX_AGE_SECONDS = 5 * 60;

export const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";

/** Whether the request came from Slack: `v0=` + HMAC-SHA256 of `v0:<timestamp>:<body>` with the signing secret, and not too old. */
export function verifySlackSignature(input: { secret: string; timestamp: string | undefined; signature: string | undefined; body: string; nowMs: number }): boolean {
  const { secret, timestamp, signature, body, nowMs } = input;
  if (!secret || timestamp === undefined || signature === undefined) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const age = Math.abs(nowMs / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SLACK_MAX_AGE_SECONDS) return false;
  const expected = `v0=${hmacSha256Hex(secret, `v0:${timestamp}:${body}`)}`;
  return safeEqual(expected, signature.trim());
}

export type SlackEvent =
  /** Slack checking the URL: answer with this challenge. */
  | { kind: "challenge"; challenge: string }
  /** A message to the Bot. */
  | { kind: "message"; message: Omit<InboundMessage, "botId" | "surface" | "receivedAt">; channel: string; threadTs: string; direct: boolean }
  /** Valid, but not for the Bot to act on. */
  | { kind: "ignore"; reason: string };

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A leading mention of the Bot, which is how it was addressed and not what was asked. */
const LEADING_MENTION = /^\s*(?:<@[UW][A-Z0-9]+(?:\|[^>]*)?>[\s,:;-]*)+/;

/**
 * What a request body from Slack means. Messages from bots (including this one), edits, deletions and every other
 * subtype are ignored, so the Bot can never be set talking to itself; a message in a channel is acted on only when the
 * Bot was mentioned, while a direct message always is.
 */
export function parseSlackEvent(body: unknown): SlackEvent {
  const top = object(body);
  if (!top) return { kind: "ignore", reason: "not an object" };
  if (top.type === "url_verification") {
    const challenge = str(top.challenge);
    return challenge ? { kind: "challenge", challenge } : { kind: "ignore", reason: "no challenge" };
  }
  if (top.type !== "event_callback") return { kind: "ignore", reason: "not an event" };
  const event = object(top.event);
  if (!event) return { kind: "ignore", reason: "no event" };
  if (event.bot_id !== undefined || event.subtype !== undefined) return { kind: "ignore", reason: "from a bot or not a plain message" };
  const type = event.type;
  if (type !== "message" && type !== "app_mention") return { kind: "ignore", reason: "not a message" };
  if (type === "message" && event.channel_type !== "im") return { kind: "ignore", reason: "a channel message that did not mention the Bot" };
  const user = str(event.user);
  const channel = str(event.channel);
  const ts = str(event.ts);
  const rawText = typeof event.text === "string" ? event.text : "";
  if (!user || !channel || !ts) return { kind: "ignore", reason: "missing sender, channel or time" };
  const text = (type === "app_mention" ? rawText.replace(LEADING_MENTION, "") : rawText).trim();
  if (text === "") return { kind: "ignore", reason: "empty" };
  const threadTs = str(event.thread_ts) ?? ts;
  // A direct message is one conversation; a thread in a channel is its own.
  const conversationKey = type === "message" ? `${channel}:${str(event.thread_ts) ?? "dm"}` : `${channel}:${threadTs}`;
  return {
    kind: "message",
    channel,
    threadTs,
    direct: type === "message",
    message: {
      senderId: user,
      senderLabel: `Slack member ${user}`,
      conversationKey,
      ...(str(top.event_id) ? { deliveryId: `slack:${str(top.event_id)}` } : {}),
      text,
    },
  };
}

/** The `chat.postMessage` request that answers in the thread the message came from. */
export function slackReplyRequest(token: string, target: { channel: string; threadTs: string; direct: boolean }, reply: string): { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } } {
  const body: Record<string, string> = { channel: target.channel, text: fitReply(reply, SURFACE_LIMITS.replyChars) };
  // A direct message is answered in the conversation, a channel mention in its thread.
  if (!target.direct) body.thread_ts = target.threadTs;
  return {
    url: SLACK_POST_URL,
    init: { method: "POST", headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` }, body: JSON.stringify(body) },
  };
}

/** Slack answers 200 even when it refuses; whether it took the message is in the body. Null when it did, else why. */
export function slackReplyFailure(response: unknown): string | null {
  const body = object(response);
  if (!body) return "Slack sent back something that was not understood.";
  if (body.ok === true) return null;
  return `Slack refused the reply: ${str(body.error) ?? "unknown error"}.`;
}
