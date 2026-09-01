import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * One dock slot for every accept/reject prompt. Inside the workspace the slot
 * sits just above the composer (first child of `.chat-column__composer`), so
 * permission/confirm cards stack in the same place as the agent's own
 * ApprovalDialog. When the composer is not mounted (Settings, Plans, upgrade
 * views) the same cards dock to a fixed bottom-center strip, so a prompt raised
 * in another view is still visible — same card, same buttons.
 *
 * The registry is module-level rather than React context: the composer slot is
 * a deep child of the tree while the fallback lives near the root, and the
 * fallback must win exactly when the slot is absent (context could only flow
 * downwards).
 */

let composerEl: HTMLElement | null = null;
let fallbackEl: HTMLElement | null = null;
const listeners = new Set<() => void>();

function currentTarget(): HTMLElement | null {
	return composerEl ?? fallbackEl;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function register(el: HTMLElement | null, kind: "composer" | "fallback"): void {
	const next = kind === "composer" ? { composer: el, fallback: fallbackEl } : { composer: composerEl, fallback: el };
	if (next.composer === composerEl && next.fallback === fallbackEl) return;
	composerEl = next.composer;
	fallbackEl = next.fallback;
	for (const listener of listeners) listener();
}

/** Element prompt cards should portal into (composer slot, else floating). */
export function usePromptDockTarget(): HTMLElement | null {
	return useSyncExternalStore(subscribe, currentTarget);
}

/** Render `children` docked above the composer (or bottom-center fallback). */
export function PromptDock({ children }: { children: ReactNode }) {
	const target = usePromptDockTarget();
	if (!target) return null;
	return createPortal(children, target);
}

/** Slot inside the workspace composer stack; registered while mounted. */
export function PromptDockSlot() {
	const ref = useRef<HTMLDivElement | null>(null);
	return (
	<div
	ref={(el) => {
	ref.current = el;
	register(el, "composer");
	}}
	className="prompt-dock"
	aria-live="polite"
	/>
	);
}

/** App-root fallback: fixed bottom-center strip, hidden while empty. */
export function PromptDockFallback() {
	const ref = useRef<HTMLDivElement | null>(null);
	return (
	<div
	ref={(el) => {
	ref.current = el;
	register(el, "fallback");
	}}
	className="prompt-dock prompt-dock--floating"
	aria-live="polite"
	/>
	);
}
