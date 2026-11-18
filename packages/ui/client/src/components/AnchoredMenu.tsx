import { createPortal } from "react-dom";
import { useRef, type ReactNode } from "react";
import { useAnchoredMenuPosition, type AnchorAlign } from "../hooks/useAnchoredMenuPosition.js";
import { useMenuDismiss } from "../hooks/useMenuDismiss.js";

interface AnchoredMenuProps {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  triggerClassName?: string;
  triggerTitle?: string;
  /** Names the trigger for assistive tech when its visible text alone would not say what it is for. */
  triggerAriaLabel?: string;
  triggerDisabled?: boolean;
  trigger: ReactNode;
  /** Class for the wrapper around the trigger. */
  className?: string;
  /** Which edge of the trigger the panel lines up with; it stays inside the window either way. */
  align?: AnchorAlign;
  panelClassName?: string;
  children: ReactNode;
}

/** Dropdown anchored to a trigger button, portalled to avoid overflow clipping. */
export function AnchoredMenu(props: AnchoredMenuProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredMenuPosition(props.open, anchorRef, panelRef, { align: props.align });
  useMenuDismiss(props.open, props.onClose, anchorRef, panelRef);

  const panel =
    props.open &&
    createPortal(
      <div
        ref={panelRef}
        className={`anchored-menu__panel${props.panelClassName ? ` ${props.panelClassName}` : ""}`}
        style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
      >
        {props.children}
      </div>,
      document.body,
    );

  return (
    <div className={props.className ? `menu ${props.className}` : "menu"}>
      <button
        ref={anchorRef}
        type="button"
        className={props.triggerClassName}
        title={props.triggerTitle}
        aria-label={props.triggerAriaLabel}
        disabled={props.triggerDisabled}
        aria-haspopup="menu"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        {props.trigger}
      </button>
      {panel}
    </div>
  );
}
