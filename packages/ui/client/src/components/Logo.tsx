/** The Deyin mark: geometric lowercase "d" with an orbit dot. Original artwork,
 * inlined so it renders without asset loading. No enclosing tile — the glyph is
 * optically centred on the canvas, so it sits right inline at any size.
 *
 * One flat blue-grey, chosen to clear both theme grounds: the mark carries no
 * background of its own, so the single value has to read on the dark window and
 * the light one alike. Mirrors packages/branding/assets/logo-mark.svg. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" aria-label="Deyin">
      {/* bowl of the "d" */}
      <circle cx="214" cy="328" r="96" stroke="#7488a0" strokeWidth="58" fill="none" />
      {/* ascender of the "d" */}
      <path d="M310 88V424" stroke="#7488a0" strokeWidth="58" strokeLinecap="round" />
      {/* orbit dot */}
      <circle cx="390" cy="115" r="27" fill="#7488a0" />
    </svg>
  );
}
