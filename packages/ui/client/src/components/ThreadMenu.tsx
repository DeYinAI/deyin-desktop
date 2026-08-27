import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon.js";
import { useAnchoredMenuPosition } from "../hooks/useAnchoredMenuPosition.js";

export type ThreadAction = "pin" | "rename" | "archive" | "unread" | "trajectory";

interface ThreadMenuProps {
  threadId: string;
  pinned: boolean;
  platform: "desktop" | "web";
  workspaceRoot: string | null;
  /** Anchor button for dropdown mode (TopBar). Portals to body with viewport clamping. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Fixed screen position (context menu); omitted when anchored to a button. */
  position?: { x: number; y: number };
  onAction: (action: ThreadAction) => void;
  onClose: () => void;
}

interface KnownPaths {
  userData: string;
  logs: string;
  config: string;
}

const VIEWPORT_EDGE = 8;

function clampFixedPosition(
  x: number,
  y: number,
  panel: DOMRect,
): { x: number; y: number } {
  return {
    x: Math.max(VIEWPORT_EDGE, Math.min(x, window.innerWidth - VIEWPORT_EDGE - panel.width)),
    y: Math.max(VIEWPORT_EDGE, Math.min(y, window.innerHeight - VIEWPORT_EDGE - panel.height)),
  };
}

/** Context menu for a task/thread: organize actions, copy paths, diagnostics. */
export function ThreadMenu(props: ThreadMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<KnownPaths | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [diagState, setDiagState] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [fixedPos, setFixedPos] = useState<{ x: number; y: number } | null>(null);
  const isDesktop = props.platform === "desktop";
  const portalled = Boolean(props.anchorRef || props.position);

  const anchorPos = useAnchoredMenuPosition(
    Boolean(props.anchorRef && !props.position),
    props.anchorRef ?? { current: null },
    ref,
    { align: "end" },
  );

  useEffect(() => {
    if (isDesktop) void window.deyin.paths.get().then(setPaths).catch(() => undefined);
  }, [isDesktop]);

  useLayoutEffect(() => {
    if (!props.position || props.anchorRef) {
      setFixedPos(null);
      return;
    }
    const place = () => {
      const panel = ref.current?.getBoundingClientRect();
      if (!panel) return;
      setFixedPos(clampFixedPosition(props.position!.x, props.position!.y, panel));
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
    };
  }, [props.position, props.anchorRef]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = (label: string, value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      setTimeout(props.onClose, 450);
    });
  };

  const act = (action: ThreadAction) => {
    props.onAction(action);
    props.onClose();
  };

  /** Upload a scrubbed diagnostics bundle; the report id lands in deyin.log. */
  const sendDiagnostics = () => {
    if (diagState === "sending") return;
    setDiagState("sending");
    void window.deyin.diagnostics
      .send()
      .then((result) => {
        setDiagState(result.ok ? "ok" : "error");
        setTimeout(props.onClose, result.ok ? 1200 : 2200);
      })
      .catch(() => {
        setDiagState("error");
        setTimeout(props.onClose, 2200);
      });
  };

  const diagLabel =
    diagState === "sending"
      ? "Sending diagnostics…"
      : diagState === "ok"
        ? "Diagnostics sent"
        : diagState === "error"
          ? "Diagnostics failed"
          : "Send diagnostics";

  const taskPath = paths ? `${paths.userData}/tasks/${props.threadId}` : props.threadId;
  const logPath = paths ? `${paths.logs}/deyin.log` : "deyin.log";

  const showOpenInFileManager = isDesktop && Boolean(props.workspaceRoot);
  const showCopyPath = Boolean(props.workspaceRoot);
  const showCopyTaskPath = isDesktop && Boolean(paths);
  const showCopyLogPath = isDesktop && Boolean(paths);
  const showGoToConfig = isDesktop && Boolean(paths);
  const showSendDiagnostics = isDesktop;
  const showPathSection =
    showOpenInFileManager ||
    showCopyPath ||
    showCopyTaskPath ||
    showCopyLogPath ||
    showGoToConfig;

  const item = (icon: IconName, label: string, onClick: () => void, disabled = false) => (
    <button className="menu__item" onClick={onClick} disabled={disabled} style={disabled ? { opacity: 0.4 } : undefined}>
      <Icon name={icon} size={13} />
      <span>{copied === label ? "Copied" : label}</span>
    </button>
  );

  const panelStyle = props.anchorRef && anchorPos
    ? { top: anchorPos.top, left: anchorPos.left, visibility: "visible" as const }
    : props.position
      ? {
          position: "fixed" as const,
          left: fixedPos?.x ?? props.position.x,
          top: fixedPos?.y ?? props.position.y,
          right: "auto" as const,
        }
      : undefined;

  const panel = (
    <div
      ref={ref}
      className={`menu__panel threadmenu${portalled ? " menu__panel--anchored" : ""}`}
      style={panelStyle}
    >
      {item("pin", props.pinned ? "Unpin task" : "Pin task", () => act("pin"))}
      {item("pencil", "Rename task", () => act("rename"))}
      {item("archive", "Archive task", () => act("archive"))}
      {item("dots", "Mark as unread", () => act("unread"))}
      {showPathSection && <div className="modelmenu__rule" />}
      {showOpenInFileManager &&
        item("folder", "Open in file manager", () => {
          if (props.workspaceRoot) window.deyin.shell.showItem(props.workspaceRoot);
          props.onClose();
        })}
      {showCopyPath && item("copy", "Copy path", () => copy("Copy path", props.workspaceRoot!))}
      {showCopyTaskPath && item("copy", "Copy task path", () => copy("Copy task path", taskPath))}
      {showCopyLogPath && item("copy", "Copy log path", () => copy("Copy log path", logPath))}
      {item("copy", "Copy session ID", () => copy("Copy session ID", props.threadId))}
      {showGoToConfig &&
        item("gear", "Go to config", () => {
          if (paths) window.deyin.shell.showItem(paths.config);
          props.onClose();
        })}
      <div className="modelmenu__rule" />
      {item("route", "View model trajectory", () => act("trajectory"))}
      {showSendDiagnostics && item("shield", diagLabel, sendDiagnostics, diagState === "sending")}
      {item("flag", "Report issue", () => {
        const url = "https://github.com/deyin-app/deyin/issues/new";
        if (isDesktop) window.deyin.shell.openExternal(url);
        else window.open(url, "_blank", "noopener");
        props.onClose();
      })}
    </div>
  );

  return portalled ? createPortal(panel, document.body) : panel;
}
