import type { ReactElement } from "react";
import { botAvatarColorValue, botAvatarMarkValue, resolveBotAvatar, type BotAvatarState, type DeyinBot } from "@deyin/host-core/shared";
import { botAvatarBody } from "./botAvatarShapes.js";

/** The part of a Bot the avatar needs, so a draft in the create form can be drawn before it exists. */
export type BotAvatarSource = Pick<DeyinBot, "avatarShape" | "avatarColor" | "name"> & Partial<Pick<DeyinBot, "avatarUrl">>;

interface BotAvatarProps {
  bot: BotAvatarSource;
  /** Edge length in px. */
  size?: number;
  /** What the Bot is doing; drives the expression. */
  state?: BotAvatarState;
  /** Next to the Bot's name the picture adds nothing for a screen reader, so it can be hidden from it. */
  decorative?: boolean;
  className?: string;
}

/** Where the mark sits, and how big its parts are, in the avatar's 100x100 box. */
const CENTER = 50;
const ORBIT_R = 20;
const CORE_R = 8;
const DOT_R = 5;
/** Nothing in the mark goes further from the center than this, which every form contains (see `botAvatarBody`). */
export const MARK_REACH = 30;

const round = (n: number): number => Math.round(n * 100) / 100;

/** A point on a circle around the center, with 0 degrees to the right and angles growing clockwise. */
function at(angle: number, radius: number = ORBIT_R): { x: number; y: number } {
  const rad = (angle * Math.PI) / 180;
  return { x: round(CENTER + radius * Math.cos(rad)), y: round(CENTER + radius * Math.sin(rad)) };
}

interface MarkProps {
  mark: string;
}

function Orbit({ mark, opacity = 0.4, dash }: MarkProps & { opacity?: number; dash?: string }) {
  return (
    <circle data-part="orbit" cx={CENTER} cy={CENTER} r={ORBIT_R} fill="none" stroke={mark} strokeOpacity={opacity} strokeWidth={3} {...(dash ? { strokeDasharray: dash } : {})} />
  );
}

function Core({ mark, r = CORE_R, opacity = 1 }: MarkProps & { r?: number; opacity?: number }) {
  return <circle data-part="core" cx={CENTER} cy={CENTER} r={r} fill={mark} fillOpacity={opacity} />;
}

/** The dot, in a group the stylesheet can turn around the center so it travels the orbit. */
function Dot({ mark, angle, radius = ORBIT_R, size = DOT_R, opacity = 1, trail = false }: MarkProps & { angle: number; radius?: number; size?: number; opacity?: number; trail?: boolean }) {
  const dot = at(angle, radius);
  const behind = at(angle - 28, radius);
  const further = at(angle - 56, radius);
  return (
    <g data-part="spin">
      {trail ? (
        <g data-part="trail">
          <circle cx={behind.x} cy={behind.y} r={round(size * 0.7)} fill={mark} fillOpacity={0.55} />
          <circle cx={further.x} cy={further.y} r={round(size * 0.45)} fill={mark} fillOpacity={0.3} />
        </g>
      ) : null}
      <circle data-part="dot" cx={dot.x} cy={dot.y} r={size} fill={mark} fillOpacity={opacity} />
    </g>
  );
}

const STROKE = { strokeLinecap: "round", strokeLinejoin: "round", fill: "none" } as const;

/**
 * The mark for one state. The orbit, the core and the dot are always the same three things; what they do says what
 * the Bot is doing. Every part stays inside the disc each form is drawn to contain.
 */
function face(state: BotAvatarState, mark: string): ReactElement {
  switch (state) {
    case "idle":
      return (
        <g data-part="mark">
          <Orbit mark={mark} />
          <Core mark={mark} />
          <Dot mark={mark} angle={-45} />
        </g>
      );
    case "thinking":
      return (
        <g data-part="mark">
          <Orbit mark={mark} />
          <Core mark={mark} />
          <Dot mark={mark} angle={-135} />
        </g>
      );
    case "working":
      return (
        <g data-part="mark">
          <Orbit mark={mark} opacity={0.55} />
          <Core mark={mark} />
          <Dot mark={mark} angle={0} trail />
        </g>
      );
    case "waiting":
      return (
        <g data-part="mark">
          <Orbit mark={mark} dash="4 5" />
          <Core mark={mark} />
          <Dot mark={mark} angle={-90} />
        </g>
      );
    case "blocked":
      return (
        <g data-part="mark">
          <Orbit mark={mark} />
          <rect data-part="bar" x={35} y={46.5} width={30} height={7} rx={3.5} fill={mark} />
          <Dot mark={mark} angle={90} />
        </g>
      );
    case "finished":
      return (
        <g data-part="mark">
          <Orbit mark={mark} opacity={0.7} />
          <path data-part="check" d="M40 51L47 58L61 43" stroke={mark} strokeWidth={5} {...STROKE} />
          <Dot mark={mark} angle={-45} />
        </g>
      );
    case "failed":
      return (
        <g data-part="mark">
          <circle data-part="orbit-broken" cx={CENTER} cy={CENTER} r={ORBIT_R} stroke={mark} strokeOpacity={0.4} strokeWidth={3} strokeDasharray="94 31.7" transform="rotate(-100 50 50)" fill="none" />
          <path data-part="cross" d="M42 42L58 58M58 42L42 58" stroke={mark} strokeWidth={5} {...STROKE} />
          <Dot mark={mark} angle={-40} radius={26} size={4} />
        </g>
      );
    case "sleeping":
      return (
        <g data-part="mark">
          <Orbit mark={mark} opacity={0.2} />
          <Core mark={mark} r={5} opacity={0.6} />
          <Dot mark={mark} angle={90} opacity={0.35} />
          <path data-part="z" d="M58 34H67L58 43H67" stroke={mark} strokeWidth={3} {...STROKE} />
        </g>
      );
    default: {
      const unhandled: never = state;
      throw new Error(`Unhandled avatar state: ${String(unhandled)}`);
    }
  }
}

/**
 * A Bot's picture: its uploaded image when it has one, otherwise its form in its color with the orbit mark that
 * shows what it is doing. The mark only moves under `prefers-reduced-motion: no-preference` (see `.bot-avatar` in
 * styles.css), so the still picture is always complete.
 */
export function BotAvatar({ bot, size = 32, state = "idle", decorative = false, className }: BotAvatarProps) {
  const label = decorative ? undefined : bot.name;
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img" as const, "aria-label": label };
  const classes = `bot-avatar bot-avatar--${state}${className ? ` ${className}` : ""}`;

  if (bot.avatarUrl) {
    return (
      <img
        src={bot.avatarUrl}
        width={size}
        height={size}
        alt={decorative ? "" : bot.name}
        className={`${classes} bot-avatar--image`}
        draggable={false}
        {...(decorative ? { "aria-hidden": true as const } : {})}
      />
    );
  }

  // A Bot from an older host can still carry an id from before the redesign; draw its closest current equivalent.
  const { shape, color } = resolveBotAvatar({ id: bot.name, avatarShape: bot.avatarShape, avatarColor: bot.avatarColor });
  const fill = botAvatarColorValue(color);
  const mark = botAvatarMarkValue(color);
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={classes} data-shape={shape} {...a11y}>
      <g fill={fill} stroke={fill} strokeWidth={4} strokeLinejoin="round">
        {botAvatarBody(shape)}
      </g>
      {face(state, mark)}
    </svg>
  );
}
