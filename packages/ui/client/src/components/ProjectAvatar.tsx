import { refAvatars, type RefAvatarHue } from "@deyin/branding";

/** Stable hue order — the same project always lands on the same colour. */
const HUES = Object.keys(refAvatars) as RefAvatarHue[];

/**
 * Pick a project's avatar hue from its identity. Deterministic so a project does
 * not change colour between renders, restarts, or machines.
 */
export function avatarHueFor(seed: string): RefAvatarHue {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return HUES[hash % HUES.length]!;
}

/** The letter shown inside the avatar: first alphanumeric of the project name. */
export function avatarInitial(name: string): string {
  const match = name.trim().match(/[a-z0-9]/i);
  return (match?.[0] ?? "•").toUpperCase();
}

/**
 * Project avatar: a filled rounded square carrying the project's initial.
 *
 * Colour comes from the reference style's avatar pairs (bg + border), which are
 * fixed per hue rather than theme-derived, so the rail reads the same in every
 * palette. Falls back to the neutral pair when the theme does not define them.
 */
export function ProjectAvatar(props: {
  name: string;
  seed?: string;
  size?: number;
  /** Renders a small unread/attention dot in the top-right, like a session tab. */
  status?: "busy" | "attention" | "unread" | "failed" | null;
}) {
  const hue = avatarHueFor(props.seed ?? props.name);
  const size = props.size ?? 20;
  return (
    <span
      className="project-avatar"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        fontSize: `${Math.round(size * 0.5)}px`,
        background: `var(--avatar-bg-${hue}, var(--color-surface-raised))`,
        borderColor: `var(--avatar-border-${hue}, var(--color-border))`,
        borderRadius: `${Math.max(4, Math.round(size * 0.28))}px`,
      }}
      aria-hidden="true"
    >
      {avatarInitial(props.name)}
      {props.status && (
        <span className={`project-avatar__dot project-avatar__dot--${props.status}`} aria-hidden="true" />
      )}
    </span>
  );
}
