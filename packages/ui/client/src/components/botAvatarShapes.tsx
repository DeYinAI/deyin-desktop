import type { ReactElement } from "react";
import type { BotAvatarShape } from "@deyin/host-core/shared";

/**
 * The body of each Bot avatar form, drawn in a 100x100 box.
 *
 * Every form keeps a disc of radius 30 around (50, 50) inside its outline: the orbit mark lives in that disc, so it
 * always sits on the body. Outlines are single fills (the bloom is four overlapping circles in the same fill). The
 * caller strokes every form with a round join in the fill color, which softens the corners without moving them.
 */
export function botAvatarBody(shape: BotAvatarShape): ReactElement {
  switch (shape) {
    case "orb":
      return <circle cx="50" cy="50" r="44" />;
    case "tile":
      return <rect x="10" y="10" width="80" height="80" rx="24" />;
    case "tilt":
      return <rect x="12" y="12" width="76" height="76" rx="22" transform="rotate(12 50 50)" />;
    case "pill":
      return <rect x="20" y="6" width="60" height="88" rx="30" />;
    case "lozenge":
      return <rect x="6" y="20" width="88" height="60" rx="30" />;
    case "hexagon":
      return <path d="M50 4L89.8 27V73L50 96L10.2 73V27Z" />;
    case "octagon":
      return <path d="M67.6 7.5L92.5 32.4V67.6L67.6 92.5H32.4L7.5 67.6V32.4L32.4 7.5Z" />;
    case "diamond":
      return <path d="M50 4L96 50L50 96L4 50Z" />;
    case "petal":
      return <path d="M50 8H92V50A42 42 0 0 1 50 92A42 42 0 0 1 8 50A42 42 0 0 1 50 8Z" />;
    case "bloom":
      return (
        <g>
          <circle cx="34" cy="34" r="26" />
          <circle cx="66" cy="34" r="26" />
          <circle cx="34" cy="66" r="26" />
          <circle cx="66" cy="66" r="26" />
        </g>
      );
    default: {
      const unhandled: never = shape;
      throw new Error(`Unhandled avatar shape: ${String(unhandled)}`);
    }
  }
}
