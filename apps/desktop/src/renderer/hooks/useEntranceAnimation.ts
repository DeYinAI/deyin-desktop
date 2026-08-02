import { useEffect, useRef } from "react";

/** GSAP-lite entrance animation respecting prefers-reduced-motion. */
export function useEntranceAnimation<T extends HTMLElement>(
  deps: unknown[] = [],
  options: { y?: number; duration?: number } = {},
) {
  const ref = useRef<T>(null);
  const { y = 8, duration = 0.28 } = options;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      el.style.opacity = "1";
      el.style.transform = "none";
      return;
    }
    el.style.opacity = "0";
    el.style.transform = `translateY(${y}px)`;
    el.style.transition = `opacity ${duration}s ease-out, transform ${duration}s ease-out`;
    const id = requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translateY(0)";
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

/** Smooth expand/collapse height for tool cards. */
export function useCollapseAnimation(open: boolean, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    if (open) {
      el.style.maxHeight = `${el.scrollHeight}px`;
      el.style.opacity = "1";
    } else {
      el.style.maxHeight = "0";
      el.style.opacity = "0.6";
    }
  }, [open, ref]);
}

/** Play attention/success chimes when enabled in settings. */
export function playFeedbackChime(kind: "attention" | "success", enabled = true) {
  if (!enabled) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = kind === "attention" ? 880 : 660;
    gain.gain.value = 0.04;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.stop(ctx.currentTime + 0.25);
    void ctx.close();
  } catch {
    // Audio not available
  }
}
