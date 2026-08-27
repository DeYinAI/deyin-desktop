import { Logo } from "./Logo.js";
import { OpenferenceLogo } from "./OpenferenceLogo.js";

/** Deyin x Openference co-brand mark for the title bar. */
export function CoBrandLogos({ size = 20 }: { size?: number }) {
  return (
    <span className="titlebar__cobrand" aria-label="Deyin and Openference">
      <Logo size={size} />
      <span className="titlebar__cobrand-sep" aria-hidden>
        ×
      </span>
      <OpenferenceLogo size={size} />
    </span>
  );
}
