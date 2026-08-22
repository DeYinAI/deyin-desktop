import { useLayoutEffect, useState, type RefObject } from "react";

const GAP = 6;
const EDGE = 8;

/** Viewport-clamped fixed position for a menu portaled to document.body. */
export function useAnchoredMenuPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
): { top: number; left: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const p = panelRef.current?.getBoundingClientRect();
      if (!a || !p) return;
      const fitsBelow = a.bottom + GAP + p.height <= window.innerHeight - EDGE;
      const fitsAbove = a.top - GAP - p.height >= EDGE;
      setPos({
        top: fitsBelow || !fitsAbove ? a.bottom + GAP : a.top - GAP - p.height,
        left: Math.max(EDGE, Math.min(a.right - p.width, window.innerWidth - EDGE - p.width)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, panelRef]);

  return pos;
}
