/** Compact inline icon set (original 16x16 stroke glyphs), themed via currentColor. */

const PATHS: Record<string, JSX.Element> = {
  plus: <path d="M8 3v10M3 8h10" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  bolt: <path d="M8.5 2L4 9h3.5L7 14l4.5-7H8z" />,
  sparkles: (
    <>
      <path d="M8 2l1.2 3.1L12.5 6 9.2 7.2 8 10.5 6.8 7.2 3.5 6l3.3-.9z" />
      <path d="M12.5 10l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
    </>
  ),
  folder: <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 2h4.5A1.5 1.5 0 0114 6.5v5A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5z" />,
  terminal: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M4.5 6.5L7 8.5l-2.5 2M8.5 10.5h3" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 1.7 2.7 3.7 2.7 6S9.8 12.3 8 14c-1.8-1.7-2.7-3.7-2.7-6S6.2 3.7 8 2z" />
    </>
  ),
  layout: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M9.5 3v10" />
    </>
  ),
  gear: (
    <>
      <path d="M12.2 6.7 14.1 6.9 14.1 9.1 12.2 9.3 11.9 10.1 13.1 11.6 11.6 13.1 10.1 11.9 9.3 12.2 9.1 14.1 6.9 14.1 6.7 12.2 5.9 11.9 4.4 13.1 2.9 11.6 4.1 10.1 3.8 9.3 1.9 9.1 1.9 6.9 3.8 6.7 4.1 5.9 2.9 4.4 4.4 2.9 5.9 4.1 6.7 3.8 6.9 1.9 9.1 1.9 9.3 3.8 10.1 4.1 11.6 2.9 13.1 4.4 11.9 5.9Z" />
      <circle cx="8" cy="8" r="1.8" />
    </>
  ),
  chevronDown: <path d="M4 6l4 4 4-4" />,
  chevronRight: <path d="M6 4l4 4-4 4" />,
  chevronLeft: <path d="M10 4L6 8l4 4" />,
  chevronsRight: <path d="M4 4l4 4-4 4M9 4l4 4-4 4" />,
  arrowLeft: <path d="M13 8H3m4-4L3 8l4 4" />,
  arrowRight: <path d="M3 8h10M9 4l4 4-4 4" />,
  arrowUp: <path d="M8 13V3M4 7l4-4 4 4" />,
  arrowDown: <path d="M8 3v10M12 9l-4 4-4-4" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  minimize: <path d="M3 8.5h10" />,
  maximize: <rect x="3.5" y="3.5" width="9" height="9" rx="1" />,
  dots: (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  refresh: <path d="M13 8a5 5 0 11-1.5-3.5M13 2.8V5h-2.2" />,
  shield: <path d="M8 1.8l5 2v4.4c0 3-2.1 5-5 6-2.9-1-5-3-5-6V3.8z" />,
  attach: <path d="M9.5 4.5L5.2 8.8a2 2 0 002.8 2.8l4.6-4.6a3.2 3.2 0 10-4.5-4.5L3.7 6.9" />,
  at: (
    <>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M10.4 8v1a1.6 1.6 0 003.2 0V8a5.6 5.6 0 10-2.2 4.5" />
    </>
  ),
  hash: <path d="M6.2 2.5l-1.4 11M11.2 2.5l-1.4 11M3 5.8h10.5M2.5 10.2H13" />,
  slash: <path d="M10 2.5l-4 11" />,
  check: <path d="M3 8.5l3.2 3L13 5" />,
  external: <path d="M6.5 3H3v10h10V9.5M9.5 3H13v3.5M13 3L7.5 8.5" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5M6.8 7v3.5M9.2 7v3.5" />,
  user: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5c.8-2.4 2.6-3.5 5-3.5s4.2 1.1 5 3.5" />
    </>
  ),
  file: <path d="M4 2h5l3 3v9H4zM9 2v3h3" />,
  diff: <path d="M5 2.5v6M2.5 5.5h5M5 11v2.5M10.5 13.5h3M10.5 10h3M10.5 6.5L13.5 3.5M13.5 6.5L10.5 3.5" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  swap: <path d="M4.5 6H13l-2.5-2.5M11.5 10H3l2.5 2.5" />,
  play: <path d="M5 3.5l7 4.5-7 4.5z" />,
  undo: <path d="M3.5 6.5H10a3.5 3.5 0 010 7H6M3.5 6.5L6 4M3.5 6.5L6 9" />,
  panel: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6 3v10" />
    </>
  ),
  cpu: (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
      <path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2" />
    </>
  ),
  book: <path d="M8 3.5C6.8 2.5 5 2.2 3 2.5v10c2-.3 3.8 0 5 1 1.2-1 3-1.3 5-1v-10c-2-.3-3.8 0-5 1zM8 3.5v10" />,
  grid: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </>
  ),
  chart: <path d="M2.5 13.5V9M6.2 13.5V5.5M9.8 13.5V7.5M13.5 13.5V3" />,
  palette: (
    <>
      <path d="M8 2a6 6 0 100 12c1.1 0 1.4-.9 1.1-1.7-.3-.9.3-1.5 1.1-1.5h1.3A2.5 2.5 0 0014 8.3 6 6 0 008 2z" />
      <circle cx="5.4" cy="7" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="5.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.6" cy="7" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  plug: <path d="M6 1.8v3.2M10 1.8v3.2M4.8 5h6.4v2.6a3.2 3.2 0 01-6.4 0zM8 10.8v3.4" />,
  anchor: (
    <>
      <circle cx="8" cy="3.6" r="1.6" />
      <path d="M8 5.2V13M8 13c-2.8 0-5-2.2-5-5M8 13c2.8 0 5-2.2 5-5" />
    </>
  ),
  brain: (
    <>
      <path d="M8 2.5c-1.2 0-2 .8-2 1.8-1.3 0-2.3 1-2.3 2.2 0 .6.2 1.1.6 1.5-.4.4-.6.9-.6 1.5 0 1.2 1 2.2 2.3 2.2 0 1 .8 1.8 2 1.8" />
      <path d="M8 2.5c1.2 0 2 .8 2 1.8 1.3 0 2.3 1 2.3 2.2 0 .6-.2 1.1-.6 1.5.4.4.6.9.6 1.5 0 1.2-1 2.2-2.3 2.2 0 1-.8 1.8-2 1.8" />
      <path d="M8 2.5v11" />
    </>
  ),
  hand: <path d="M5 8V3.8a1 1 0 012 0V7m0-3.9a1 1 0 012 0V7m0-2.6a1 1 0 012 0V7m0-.9a1 1 0 012 0v3.4c0 2.5-2 4.5-4.5 4.5h-.6c-1.3 0-2.5-.6-3.3-1.6L2.9 10a1.1 1.1 0 011.7-1.4L5 9.2" />,
  pencil: <path d="M9.8 3.2l3 3L5.5 13.5l-3.3.7.7-3.3zM8.7 4.3l3 3" />,
  eye: (
    <>
      <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  link: <path d="M6.5 9.5l3-3M5 7L3.6 8.4a2.4 2.4 0 003.4 3.4L8.4 10.4M11 9l1.4-1.4a2.4 2.4 0 00-3.4-3.4L7.6 5.6" />,
  pin: <path d="M6.2 2.5h3.6l-.5 4.2 2.2 2.3H4.5l2.2-2.3zM8 9v4.5" />,
  archive: (
    <>
      <rect x="2.5" y="3" width="11" height="3" rx="0.8" />
      <path d="M3.5 6v6.2a0.8 0.8 0 00.8.8h7.4a0.8 0.8 0 00.8-.8V6M6.5 8.5h3" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M10.5 5.5V3.7A1.2 1.2 0 009.3 2.5H3.7A1.2 1.2 0 002.5 3.7v5.6a1.2 1.2 0 001.2 1.2h1.8" />
    </>
  ),
  flag: <path d="M4 14V2.5M4 3h8l-1.8 2.5L12 8H4" />,
  route: <path d="M4 13.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM12 5.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM12 5.5v3a2 2 0 01-2 2H5.5" />,
  message: <path d="M2.5 4.5A1.5 1.5 0 014 3h8a1.5 1.5 0 011.5 1.5v4A1.5 1.5 0 0112 10H7l-3 3v-3a1.5 1.5 0 01-1.5-1.5z" />,
  zoom: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3 3M7 5v4M5 7h4" />
    </>
  ),
  rocket: <path d="M8 1.5l1.5 3 3 1.5-3 1.5L8 11l-1.5-3-3-1.5 3-1.5zM5.5 10.5L4 13M10.5 10.5L12 13" />,
  logout: <path d="M6 8H2.5M5 5L2.5 8l2.5 3M9 2.5h2.5A1.5 1.5 0 0113 4v8a1.5 1.5 0 01-1.5 1.5H9" />,
};

export type IconName = keyof typeof PATHS & string;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {PATHS[name] ?? null}
    </svg>
  );
}
