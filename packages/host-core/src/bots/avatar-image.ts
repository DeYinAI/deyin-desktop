import { cleanBotLine } from "./types.js";

/**
 * Making a Bot's picture from a description. These are the parts that need no model and no window: what a
 * description may be, the request that goes to the image model, and how a picture is cut down to an avatar.
 */

/** The longest description of a picture; the avatar editor's box stops here too. */
export const AVATAR_PROMPT_LIMIT = 300;

/** Side of the square a generated picture is cut down to. A Bot's list shows it at about 34 pixels. */
export const AVATAR_IMAGE_PIXELS = 256;

/**
 * Length of a data URL a generated picture is kept under (the Bot record allows more). It keeps the roster, which
 * is sent to every window after every change, small.
 */
export const AVATAR_GENERATED_BUDGET = 120_000;

/** What the window sends to make a picture. The model is one of the image models the person already has. */
export interface BotAvatarRequest {
  /** What the picture should show, in the person's words. */
  prompt: string;
  /** The image model, as listed under Settings, Models. */
  model: string;
  /** Whose model it is; left out for the Openference account. */
  providerId?: string;
  /** The Bot's name, so the picture is made for it. */
  botName?: string;
}

/** A picture made for a Bot, ready to be saved as its avatar. Nothing is saved until the person says so. */
export interface BotAvatarPicture {
  /** A PNG or JPEG data URL, already cut down to avatar size. */
  url: string;
}

export type AvatarPromptCheck = { ok: true; text: string } | { ok: false; error: string };

/** Check what a person typed to describe a picture. The text comes back as one line. */
export function checkAvatarPrompt(value: unknown): AvatarPromptCheck {
  const text = cleanBotLine(value);
  if (!text) return { ok: false, error: "Describe the picture you want." };
  if (text.length > AVATAR_PROMPT_LIMIT) {
    return { ok: false, error: `Keep the description under ${AVATAR_PROMPT_LIMIT} characters.` };
  }
  return { ok: true, text };
}

/**
 * The request sent to the image model: the person's description inside a frame that asks for a square picture
 * of one subject with no lettering, because a Bot's picture is small and words in it would be unreadable.
 */
export function avatarImagePrompt(description: string, botName?: string): string {
  const name = cleanBotLine(botName).replace(/["\u201c\u201d]/g, "");
  const subject = name ? `a profile picture for an AI assistant called "${name}"` : "a profile picture for an AI assistant";
  return `${description.trim()}\n\nThis is ${subject}: a square picture with one centered subject on a clean, uncluttered background. No text, letters, numbers or logos.`;
}

/** The part of a picture kept when it is cut to a square: the middle. */
export interface SquareCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function squareCrop(width: number, height: number): SquareCrop {
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side };
}

/** The side a picture of `side` pixels is resized to: never larger than it is. */
export function avatarSide(side: number): number {
  return Math.min(side, AVATAR_IMAGE_PIXELS);
}
