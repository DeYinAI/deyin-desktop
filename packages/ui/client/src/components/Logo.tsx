/** The Deyin mark, inlined so it renders without asset loading.
 * Mirrors packages/branding/assets/logo-mark.svg.
 *
 * With `tint` the mark is drawn in one solid color instead of the blue gradient, which is how
 * the product switcher tells Deyin Code, Deyin Bot and Deyin Conductor apart. */
export function Logo({ size = 28, className, tint }: { size?: number; className?: string; tint?: string }) {
  const ink = tint ?? "url(#deyinInk)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="17 13 70 70"
      fill="none"
      aria-label="Deyin"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {!tint && (
        <defs>
          <linearGradient id="deyinInk" x1="24" y1="20" x2="72" y2="76" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#8fb4ff" />
            <stop offset="1" stopColor="#4f7cff" />
          </linearGradient>
        </defs>
      )}
      {/* bowl of the "d" */}
      <circle cx="44" cy="57" r="15" stroke={ink} strokeWidth="8" fill="none" />
      {/* ascender of the "d" */}
      <path d="M59 22V72" stroke={ink} strokeWidth="8" strokeLinecap="round" />
      {/* orbit dot */}
      <circle cx="74" cy="27" r="5" fill={tint ?? "#9fd2ff"} />
    </svg>
  );
}
