/** GitHub outbound channel and pull-request binding. */
import { sameName } from "../core/text.js";
import type { Receipt, Ticket } from "../core/types.js";
import { GithubError, type GithubClient } from "./client.js";
import { MARKER, githubAddress, parseComment, parseIssue } from "./triggers.js";

/** Posts a receipt as an issue/PR comment, or as a review-thread reply when its address names a discussion comment. */
export async function sendReceipt(
  client: GithubClient,
  input: { repository: string; agent: string },
  receipt: Receipt,
  signal?: AbortSignal,
): Promise<"sent" | "gone"> {
  const { repository, agent } = input;
  const number = Number(receipt.channel.address.number);
  if (!Number.isInteger(number) || number <= 0) throw new Error("Missing GitHub reply target");
  const marker = `${MARKER}${receipt.id} -->`;
  try {
    const address = githubAddress(receipt.channel.address.url ?? "", repository);
    let rootId: number | undefined;
    if (address?.pr && address.discussion && address.number === number) {
      // Fall back to a top-level comment if the inline comment was deleted.
      try {
        const source = parseComment(await client.get<unknown>(`repos/${repository}/pulls/comments/${address.discussion}`, undefined, signal));
        rootId = source.in_reply_to_id ?? source.id;
      } catch (error) {
        if (!(error instanceof GithubError && (error.status === 404 || error.status === 410))) throw error;
      }
    }
    // A retry after an unconfirmed send must not post twice: look for the marker among comments made since the receipt.
    const path = rootId === undefined ? `repos/${repository}/issues/${number}/comments` : `repos/${repository}/pulls/${number}/comments`;
    const recent = await client.paginate<unknown>(path, { since: receipt.createdAt }, { maxPages: 10, ...(signal ? { signal } : {}) });
    const delivered = recent.items.some((raw) => {
      const comment = parseComment(raw);
      return sameName(comment.user.login, agent) && (comment.body ?? "").includes(marker) && (rootId === undefined || comment.in_reply_to_id === rootId);
    });
    if (delivered) return "sent";
    const target = rootId === undefined ? path : `${path}/${rootId}/replies`;
    await client.post(target, { body: `${receipt.text}\n\n${marker}` }, signal);
    return "sent";
  } catch (error) {
    // Deleted (410) or locked (403) conversations never accept the reply.
    if (error instanceof GithubError && (error.status === 410 || (error.status === 403 && /locked/i.test(error.message)))) return "gone";
    throw error;
  }
}

export interface PullClaim {
  number: number;
  /** Set when the pull request may be bound to the ticket. */
  refusal?: string;
}

/**
 * Decides whether `ticket` may claim pull request `number` as its own: it is the pull request that started the ticket, or one the
 * agent account opened from a branch whose last path segment is the ticket's worktree name.
 */
export async function claimPull(
  client: GithubClient,
  input: { repository: string; agent: string },
  ticket: Ticket,
  number: number,
  signal?: AbortSignal,
): Promise<PullClaim> {
  const { repository, agent } = input;
  let issue;
  try {
    issue = parseIssue(await client.get<unknown>(`repos/${repository}/issues/${number}`, undefined, signal));
  } catch (error) {
    if (error instanceof GithubError && error.status === 404) return { number, refusal: `#${number} does not exist in ${repository}` };
    throw error;
  }
  if (!issue.pull_request) return { number, refusal: `#${number} is an issue, not a pull request` };
  const source = ticket.follows?.some((follow) => follow.thread === `github:${number}` && !follow.own) === true;
  if (source) return { number };
  if (!sameName(issue.user.login, agent)) return { number, refusal: `Pull request #${number} was not opened by ${agent}; only the source PR or one opened by the agent can be claimed` };
  const pull = await client.get<{ head?: { ref?: unknown } }>(`repos/${repository}/pulls/${number}`, undefined, signal);
  const branch = typeof pull.head?.ref === "string" ? pull.head.ref : "";
  const name = ticket.execution?.name ?? "";
  if (!name || branch.split("/").at(-1) !== name) {
    return { number, refusal: `Pull request #${number} is from branch "${branch}"; the last path segment must be the ticket name "${name}" (for example agent/${name})` };
  }
  if (issue.state === "closed") return { number, refusal: `Pull request #${number} is already closed` };
  return { number };
}
