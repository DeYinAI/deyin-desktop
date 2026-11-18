/** Pure helpers for the composer's "/" command menu, kept apart so they can be tested without a DOM. */

/** Keep a highlighted index inside the list (an empty list has no valid index). */
export function clampSlashIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}

/** Move the highlight by one row, wrapping at both ends. */
export function stepSlashIndex(index: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  return (clampSlashIndex(index, count) + delta + count) % count;
}
