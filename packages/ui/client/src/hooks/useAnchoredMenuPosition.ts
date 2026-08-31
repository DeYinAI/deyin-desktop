import { useLayoutEffect, useState, type RefObject } from "react";

const DEFAULT_GAP = 6;
const EDGE = 8;

export type AnchorAlign = "start" | "end";

export interface AnchorPositionOptions {
  align?: AnchorAlign;
  /** Stretch the panel to the anchor element's width. */
  matchAnchorWidth?: boolean;
  gap?: number;
}

export type AnchoredPosition = { top: number; left: number; width?: number };

/** Viewport-clamped fixed position for a menu portaled to document.body. */
export function useAnchoredMenuPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  options: AnchorPositionOptions = {},
): AnchoredPosition | null {
  const [pos, setPos] = useState<AnchoredPosition | null>(null);
  const align = options.align ?? "start";
  const matchAnchorWidth = options.matchAnchorWidth ?? false;
  const gap = options.gap ?? DEFAULT_GAP;

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const p = panelRef.current?.getBoundingClientRect();
      if (!a || !p) return;

      const maxPanelH = window.innerHeight - 2 * EDGE;
      const panelH = Math.min(p.height, maxPanelH);
      const panelW = matchAnchorWidth ? a.width : p.width;
      const spaceBelow = window.innerHeight - EDGE - (a.bottom + gap);
      const spaceAbove = a.top - gap - EDGE;

      let top: number;
      if (spaceBelow >= panelH) top = a.bottom + gap;
      else if (spaceAbove >= panelH) top = a.top - gap - panelH;
      else if (spaceBelow >= spaceAbove) top = a.bottom + gap;
      else top = a.top - gap - panelH;

      top = Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - panelH));
      const left =
        align === "end"
          ? Math.max(EDGE, Math.min(a.right - panelW, window.innerWidth - EDGE - panelW))
          : Math.max(EDGE, Math.min(a.left, window.innerWidth - EDGE - panelW));

      setPos(matchAnchorWidth ? { top, left, width: panelW } : { top, left });
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const panel = panelRef.current;
    const ro =
      panel &&
      new ResizeObserver(() => {
        place();
      });
    if (ro && panel) ro.observe(panel);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      ro?.disconnect();
    };
  }, [open, anchorRef, panelRef, align, matchAnchorWidth, gap]);

  return pos;
}
