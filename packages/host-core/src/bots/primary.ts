import { BOT_LIMITS, type DeyinBot } from "./types.js";
import { canSitInRoom, roomMemberLine } from "./room.js";

/** Tag that wraps what a primary Bot is told about the Bots it coordinates. */
export const PRIMARY_PERSONA_TAG = "bot_primary";

const TAGS = new RegExp(`</?${PRIMARY_PERSONA_TAG}[^>]*>`, "gi");

/** The Bots a primary Bot coordinates, and how many more there are than it is told about. */
export interface CoordinatedBots {
  bots: DeyinBot[];
  more: number;
}

/**
 * The Bots a primary Bot hands work to: every other active agent Bot, the most recently changed first (those
 * are the ones the person is likely to mean), at most `maxCoordinatedBots`. Rooms are not Bots to hand work to
 * (they are conversations), and a primary Bot does not coordinate itself.
 */
export function coordinatedBots(primary: DeyinBot, bots: readonly DeyinBot[]): CoordinatedBots {
  const others = bots
    .filter((bot) => bot.id !== primary.id && canSitInRoom(bot))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { bots: others.slice(0, BOT_LIMITS.maxCoordinatedBots), more: Math.max(0, others.length - BOT_LIMITS.maxCoordinatedBots) };
}

/**
 * What the person's primary Bot is told on top of its own persona. It is the main point of contact: it takes
 * what the person says, answers what is its own to answer, and hands the rest to the Bot that owns it, who
 * answers as itself. Pure, so the same text is previewed and sent.
 *
 * It only makes sense where the run can call the Bots by handle (the run gives them to it as subagents). In a
 * routine (`unattended`) nobody is there to answer a question and the Bot-making tools are not on hand, so it is
 * told to report what it found and is not told to suggest, create or offer anything.
 */
export function buildPrimaryPersona(others: readonly DeyinBot[], more = 0, options: { unattended?: boolean } = {}): string {
  const unattended = options.unattended === true;
  const roster = others
    .map(roomMemberLine)
    .join("\n")
    .replace(TAGS, "")
    .trim();
  const lines: string[] = [
    "You are the person's primary Bot: their main point of contact, and the one who coordinates their other Bots. They come to you first.",
  ];
  if (others.length === 0) {
    lines.push(
      "They have no other Bots yet. Help them work out what a first one should do (one job each), and create it with `bot_create` once they agree.",
    );
  } else {
    const rest = more > 0 ? (unattended ? `\n...and ${more} more.` : `\n...and ${more} more. Call \`bot_list\` to see all of them.`) : "";
    lines.push(`Their other Bots:\n${roster}${rest}`);
    lines.push(
      "When a request belongs to one of them, hand it over with the task tool, using that Bot's handle as the subagent. Give it the request in full and anything it needs from this conversation, because it cannot see the conversation. Then show its answer under its name, like **Name:** and the answer, without rewriting what it said.",
    );
    lines.push(
      'When the person writes @handle, that is the Bot they want. When a request spans several Bots, ask each for its part and put the results together. When they address everyone (a standup, "what\'s new", "all of you"), ask each Bot in turn what it did and what it needs, and sum it up. Never invent an update for a Bot you did not ask.',
    );
    if (unattended) {
      lines.push(
        "Do what belongs to no other Bot yourself. Say who you handed work to, and never claim a Bot did something it did not. If a Bot cannot answer, say so under its name. This is a scheduled run and nobody is here to answer a question, so do not wait for a reply: report what each Bot said and what needs the person's attention.",
      );
    } else {
      lines.push(
        "Do what belongs to no other Bot yourself. When the same kind of request keeps coming back, or a job needs its own memory and routines, suggest a focused Bot for it (one job each), and create it with `bot_create` once the person agrees. Say who you handed work to, and never claim a Bot did something it did not. If a Bot cannot answer, say so under its name.",
      );
      lines.push(
        "Once they have a few Bots, offer a regular check-in, once: a routine of yours (made with `routine_create`) that asks each Bot in turn what it did and what it needs, then sums it up for them. Say what it would do and suggest a time, such as weekday mornings. Set it up only after they agree to it and to the time, and do not make one they have not asked for. If they decline, save that with `remember` as a preference so you do not ask again.",
      );
    }
  }
  return `<${PRIMARY_PERSONA_TAG}>\n${lines.join("\n")}\n</${PRIMARY_PERSONA_TAG}>`;
}
