import { createPortal } from "react-dom";
import { useRef, type ReactNode } from "react";
import { useAnchoredMenuPosition } from "../hooks/useAnchoredMenuPosition.js";
import { useMenuDismiss } from "../hooks/useMenuDismiss.js";

interface AnchoredMenuProps {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  triggerClassName?: string;
  triggerTitle?: string;
  trigger: ReactNode;
  panelClassName?: string;
  children: ReactNode;
}

/** Dropdown anchored to a trigger button, portalled to avoid overflow clipping. */
export function AnchoredMenu(props: AnchoredMenuProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredMenuPosition(props.open, anchorRef, panelRef);
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
    <div className="menu">
      <button
        ref={anchorRef}
        type="button"
        className={props.triggerClassName}
        title={props.triggerTitle}
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
