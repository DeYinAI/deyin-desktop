/** The Deyin mark: geometric lowercase "d" with an orbit dot. Original artwork,
 * inlined so it renders without asset loading. Mirrors packages/branding/assets. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" fill="none" aria-label="Deyin">
      <defs>
        <linearGradient id="deyinBg" x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#151b2e" />
          <stop offset="1" stopColor="#0a0e18" />
        </linearGradient>
        <linearGradient id="deyinInk" x1="24" y1="20" x2="72" y2="76" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8fb4ff" />
          <stop offset="1" stopColor="#4f7cff" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="22" fill="url(#deyinBg)" />
      <rect x="1" y="1" width="94" height="94" rx="21" stroke="#2a3350" strokeWidth="2" fill="none" />
      <circle cx="44" cy="57" r="15" stroke="url(#deyinInk)" strokeWidth="8" fill="none" />
      <path d="M59 22V72" stroke="url(#deyinInk)" strokeWidth="8" strokeLinecap="round" />
      <circle cx="74" cy="27" r="5" fill="#9fd2ff" />
    </svg>
  );
}
