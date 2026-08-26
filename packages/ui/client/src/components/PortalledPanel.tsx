import { createPortal } from "react-dom";
import { useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import {
  useAnchoredMenuPosition,
  type AnchorAlign,
  type AnchorPositionOptions,
} from "../hooks/useAnchoredMenuPosition.js";
import { useMenuDismiss } from "../hooks/useMenuDismiss.js";

interface PortalledPanelProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  className?: string;
  align?: AnchorAlign;
  matchAnchorWidth?: boolean;
  gap?: number;
  role?: string;
  ariaLabel?: string;
  children: ReactNode;
}

/** Fixed panel portalled to document.body, anchored to any element. */
export function PortalledPanel(props: PortalledPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const positionOptions: AnchorPositionOptions = {
    align: props.align,
    matchAnchorWidth: props.matchAnchorWidth,
    gap: props.gap,
  };
  const pos = useAnchoredMenuPosition(props.open, props.anchorRef, panelRef, positionOptions);
  useMenuDismiss(props.open, props.onClose, props.anchorRef, panelRef);

  if (!props.open) return null;

  const style: CSSProperties = {
    top: pos?.top ?? 0,
    left: pos?.left ?? 0,
    visibility: pos ? "visible" : "hidden",
    ...(pos?.width !== undefined ? { width: pos.width } : {}),
  };

  return createPortal(
    <div
      ref={panelRef}
      className={props.className}
      style={style}
      role={props.role}
      aria-label={props.ariaLabel}
    >
      {props.children}
    </div>,
    document.body,
  );
}
