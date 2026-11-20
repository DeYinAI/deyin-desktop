/**
 * Whether the timeline is following the newest message ("pinned"), decided from a scroll reading.
 *
 * A scroll event is delivered a frame after the scroll that caused it. By then the layout may have changed (a
 * permission card appeared and the viewport got shorter, or a card above grew), so the distance from the bottom can
 * read as large although the person never scrolled. Reading that as "scrolled away" un-pinned the view and every
 * later message landed out of sight. Only moving up is a person leaving the bottom; being near the bottom pins again.
 */

/** Distance from the bottom (px) within which the view counts as pinned. */
export const PIN_THRESHOLD = 64;

export interface ScrollReading {
  /** `scrollTop` now. */
  top: number;
  /** `scrollHeight`. */
  height: number;
  /** `clientHeight`. */
  viewport: number;
}

/**
 * The pinned state after a scroll event. `lastTop` is `scrollTop` at the previous event or programmatic scroll.
 * Near the bottom is always pinned. Further away it is unpinned only when the view moved up; a change in layout
 * that leaves the view where it was (or moved it down) keeps what it was.
 */
export function readPin(wasPinned: boolean, lastTop: number, now: ScrollReading): boolean {
  const distance = now.height - now.top - now.viewport;
  if (distance <= PIN_THRESHOLD) return true;
  return now.top < lastTop - 1 ? false : wasPinned;
}
