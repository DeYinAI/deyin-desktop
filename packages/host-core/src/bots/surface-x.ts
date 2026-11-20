import { SURFACE_LIMITS, type InboundMessage } from "./surfaces.js";

/**
 * @mentions of a Bot's X account. The hub asks X for new mentions on a slow timer and hands each from an allowed
 * account to a routine; whatever the Bot wants to say back is a draft in the Outbox until the person approves it, and
 * only then is it posted. Nothing is ever posted on its own. The shapes are those of the X API v2 documentation.
 */

export const X_API = "https://api.x.com/2";

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The request for mentions newer than `sinceId`. */
export function xMentionsRequest(token: string, userId: string, sinceId?: string): { url: string; init: { method: "GET"; headers: Record<string, string> } } {
  const query = new URLSearchParams({
    max_results: "100",
    "tweet.fields": "author_id,conversation_id,created_at",
    expansions: "author_id",
    "user.fields": "username",
  });
  if (sinceId && /^\d{1,25}$/.test(sinceId)) query.set("since_id", sinceId);
  return { url: `${X_API}/users/${encodeURIComponent(userId)}/mentions?${query.toString()}`, init: { method: "GET", headers: { authorization: `Bearer ${token}` } } };
}

export interface XMention {
  /** The post, to answer it. */
  tweetId: string;
  message: Omit<InboundMessage, "botId" | "surface" | "receivedAt">;
  author: string;
}

export interface XMentions {
  mentions: XMention[];
  /** The newest id X reported, to ask for only what is newer next time. */
  newestId?: string;
}

/** A leading `@handle` run is how the post was addressed, not what it says. */
const LEADING_HANDLES = /^\s*(?:@[A-Za-z0-9_]{1,15}(?:\s+|$))+/;

/** The mentions in an answer from X, oldest first so replies go out in the order people wrote. The Bot's own posts are skipped. */
export function parseXMentions(response: unknown, selfUserId: string): XMentions {
  const body = object(response);
  const data = body?.data;
  const newest = str(object(body?.meta)?.newest_id);
  if (!Array.isArray(data)) return { mentions: [], ...(newest ? { newestId: newest } : {}) };
  const users = new Map<string, string>();
  const included = object(body?.includes)?.users;
  if (Array.isArray(included)) {
    for (const user of included) {
      const record = object(user);
      const id = str(record?.id);
      const username = str(record?.username);
      if (id && username) users.set(id, username.toLowerCase());
    }
  }
  const mentions: XMention[] = [];
  for (const entry of data) {
    const tweet = object(entry);
    const id = str(tweet?.id);
    const authorId = str(tweet?.author_id);
    const rawText = str(tweet?.text);
    if (!tweet || !id || !/^\d{1,25}$/.test(id) || !authorId || !rawText || authorId === selfUserId) continue;
    const text = rawText.replace(LEADING_HANDLES, "").trim();
    if (text === "") continue;
    const handle = users.get(authorId);
    mentions.push({
      tweetId: id,
      author: handle ? `@${handle}` : authorId,
      message: {
        senderId: handle ?? authorId,
        senderAliases: handle ? [handle, authorId] : [authorId],
        senderLabel: handle ? `@${handle} on X` : `X user ${authorId}`,
        conversationKey: str(tweet.conversation_id) ?? id,
        deliveryId: `x:${id}`,
        text,
      },
    });
  }
  mentions.sort((a, b) => (BigInt(a.tweetId) < BigInt(b.tweetId) ? -1 : BigInt(a.tweetId) > BigInt(b.tweetId) ? 1 : 0));
  return { mentions, ...(newest ? { newestId: newest } : {}) };
}

/** The request that posts `text` as a reply to a post. */
export function xPostRequest(token: string, text: string, inReplyTo: string): { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } } {
  return {
    url: `${X_API}/tweets`,
    init: {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: inReplyTo } }),
    },
  };
}

export type XPostResult = { ok: true; id: string; url: string } | { ok: false; error: string };

/** What X's answer to a post means: where it went, or why it did not. */
export function readXPostResult(status: number, response: unknown): XPostResult {
  const body = object(response);
  const id = str(object(body?.data)?.id);
  if (status >= 200 && status < 300 && id) return { ok: true, id, url: `https://x.com/i/web/status/${id}` };
  const detail = str(body?.detail) ?? str(body?.title) ?? str(object(Array.isArray(body?.errors) ? body?.errors[0] : undefined)?.message);
  if (status === 429) return { ok: false, error: "X says too many posts have been made just now. Try again later." };
  if (status === 401 || status === 403) return { ok: false, error: `X would not allow the post (${status})${detail ? `: ${detail}` : "."} Check the access token and that it may write posts.` };
  return { ok: false, error: `X did not take the post (${status})${detail ? `: ${detail}` : "."}` };
}

/** Whether `id` is a post id X would recognise, so nothing odd is put in a URL or body. */
export function isPostId(id: string): boolean {
  return /^\d{1,25}$/.test(id);
}

/** A reply made to fit a post: cut at the limit, by characters rather than by bytes so nothing is split in half. */
export function fitPost(reply: string): string {
  const characters = [...reply.replace(/\u0000/g, "").trim()];
  if (characters.length <= SURFACE_LIMITS.xChars) return characters.join("");
  return `${characters.slice(0, SURFACE_LIMITS.xChars - 1).join("").trimEnd()}…`;
}
