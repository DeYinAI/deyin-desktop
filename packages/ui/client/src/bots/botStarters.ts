import { coordinatedBots, type DeyinBot, type MessageKey } from "@deyin/host-core/shared";

/**
 * What a Bot's empty conversation says. A Bot is set up by talking to it, so the first screen is where the
 * person learns that: what to tell it, and a few openings to start from.
 *
 * - `fresh`: an agent with no job yet. Tell it the job, the sources, and what to ask first.
 * - `ready`: an agent that has a job (from a template, or set earlier). Ask, adjust a rule, or set up a routine.
 * - `primary`: the person's main point of contact, which sets up and coordinates the others.
 * - `room`: several Bots in one conversation.
 */
export type EmptyKind = "fresh" | "ready" | "primary" | "room";

export interface Starter {
  label: MessageKey;
  /** What is put in the composer. The person finishes it and sends it. */
  text: MessageKey;
}

export interface EmptyCopy {
  title: MessageKey;
  body: MessageKey;
}

export function emptyKindOf(bot: Pick<DeyinBot, "kind" | "isPrimary" | "purpose">): EmptyKind {
  if (bot.kind === "room") return "room";
  if (bot.isPrimary) return "primary";
  return (bot.purpose ?? "").trim() ? "ready" : "fresh";
}

export const EMPTY_COPY: Readonly<Record<EmptyKind, EmptyCopy>> = {
  fresh: { title: "bot.empty.freshTitle", body: "bot.empty.freshBody" },
  ready: { title: "bot.empty.readyTitle", body: "bot.empty.readyBody" },
  primary: { title: "bot.empty.primaryTitle", body: "bot.empty.primaryBody" },
  room: { title: "bot.empty.roomTitle", body: "bot.empty.roomBody" },
};

const JOB: Starter = { label: "bot.starter.job.label", text: "bot.starter.job.text" };
const RULE: Starter = { label: "bot.starter.rule.label", text: "bot.starter.rule.text" };
const ROUTINE: Starter = { label: "bot.starter.routine.label", text: "bot.starter.routine.text" };
const CAN: Starter = { label: "bot.starter.can.label", text: "bot.starter.can.text" };
const TEAM: Starter = { label: "bot.starter.team.label", text: "bot.starter.team.text" };
const NEWS: Starter = { label: "bot.starter.news.label", text: "bot.starter.news.text" };
const STANDUP: Starter = { label: "bot.starter.standup.label", text: "bot.starter.standup.text" };

export const STARTERS: Readonly<Record<EmptyKind, readonly Starter[]>> = {
  fresh: [JOB, RULE, ROUTINE],
  ready: [CAN, ROUTINE, RULE],
  primary: [TEAM, NEWS, RULE],
  room: [STANDUP],
};

/** The text of a starter put into the composer: on its own when the box is empty, after what is there otherwise. */
export function withStarter(current: string, text: string): string {
  return current.trim() === "" ? text : `${current.trimEnd()} ${text}`;
}

/** How many of the primary Bot's other Bots are shown as chips above its conversation. The rest are one `@` away. */
export const HEADER_CHIP_LIMIT = 6;

/** The Bots shown as chips in a Bot's header: a room's members, or the primary Bot's other Bots. None for any other Bot. */
export function headerChips(bot: DeyinBot, members: readonly DeyinBot[], bots: readonly DeyinBot[]): DeyinBot[] {
  if (bot.kind === "room") return [...members];
  if (!bot.isPrimary) return [];
  return coordinatedBots(bot, bots).bots.slice(0, HEADER_CHIP_LIMIT);
}
