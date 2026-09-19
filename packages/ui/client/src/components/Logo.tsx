/** The Deyin mark, inlined so it renders without asset loading.
 * Mirrors packages/branding/assets/logo-mark.svg. */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
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
      <defs>
        <linearGradient id="deyinInk" x1="24" y1="20" x2="72" y2="76" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8fb4ff" />
          <stop offset="1" stopColor="#4f7cff" />
        </linearGradient>
      </defs>
      {/* bowl of the "d" */}
      <circle cx="44" cy="57" r="15" stroke="url(#deyinInk)" strokeWidth="8" fill="none" />
      {/* ascender of the "d" */}
      <path d="M59 22V72" stroke="url(#deyinInk)" strokeWidth="8" strokeLinecap="round" />
      {/* orbit dot */}
      <circle cx="74" cy="27" r="5" fill="#9fd2ff" />
    </svg>
  );
}
