import type { InboundMessage } from "./surfaces.js";

/**
 * Email into a Bot. A mail service (or a small forwarder the owner runs, such as a Cloudflare Email Worker) posts each
 * message as JSON to the Bot's address on the hub, signed with the shared secret. Two shapes are read: a plain one
 * (`from`, `subject`, `text`) and Postmark's inbound JSON. Replying by email is not built; the Bot's answer stays in
 * the routine's history.
 */

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The bare address in `Ada <ada@example.com>` or `ada@example.com`, lower-cased, or null when there is none. */
export function addressOf(value: string): string | null {
  const bracketed = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  const candidate = (bracketed?.[1] ?? value).trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate) ? candidate : null;
}

/** A subject without the `Re:` and `Fwd:` that replies add, so a thread is one conversation. */
export function threadSubject(subject: string): string {
  let current = subject.trim();
  for (;;) {
    const next = current.replace(/^\s*(?:re|fwd?|aw|wg)\s*:\s*/i, "");
    if (next === current) break;
    current = next;
  }
  return current.trim().toLowerCase().slice(0, 200);
}

export type EmailDelivery =
  | { kind: "message"; message: Omit<InboundMessage, "botId" | "surface" | "receivedAt"> }
  | { kind: "ignore"; reason: string };

/**
 * What a posted email means. Whoever signed the request vouches that the mail was received, not that the sender is who
 * they say, so the allow list is the only thing that decides whose mail the Bot acts on.
 */
export function parseEmailDelivery(body: unknown): EmailDelivery {
  const mail = object(body);
  if (!mail) return { kind: "ignore", reason: "not an object" };
  const postmark = object(mail.FromFull);
  const fromRaw = str(postmark?.Email) ?? str(mail.from) ?? str(mail.From);
  const address = fromRaw ? addressOf(fromRaw) : null;
  if (!address) return { kind: "ignore", reason: "no sender address" };
  const subject = (str(mail.subject) ?? str(mail.Subject) ?? "").trim();
  // Postmark gives the new text without the quoted thread as StrippedTextReply; prefer it, then the plain text.
  const text = (str(mail.StrippedTextReply) ?? str(mail.text) ?? str(mail.TextBody) ?? "").trim();
  if (subject === "" && text === "") return { kind: "ignore", reason: "empty" };
  const messageId = str(mail.messageId) ?? str(mail.MessageID);
  const name = str(postmark?.Name);
  return {
    kind: "message",
    message: {
      senderId: address,
      senderLabel: name ? `${name} <${address}>` : address,
      conversationKey: `${address}:${threadSubject(subject)}`,
      ...(messageId ? { deliveryId: `email:${messageId}` } : {}),
      text: subject ? `Subject: ${subject}\n\n${text}`.trim() : text,
    },
  };
}
