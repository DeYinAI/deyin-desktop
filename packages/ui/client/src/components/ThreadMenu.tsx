import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon.js";

export type ThreadAction = "pin" | "rename" | "archive" | "unread" | "trajectory";

interface ThreadMenuProps {
  threadId: string;
  pinned: boolean;
  platform: "desktop" | "web";
  workspaceRoot: string | null;
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

/** Context menu for a task/thread: organize actions, copy paths, diagnostics. */
export function ThreadMenu(props: ThreadMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<KnownPaths | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [diagState, setDiagState] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const isDesktop = props.platform === "desktop";

  useEffect(() => {
    if (isDesktop) void window.deyin.paths.get().then(setPaths).catch(() => undefined);
  }, [isDesktop]);

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

  const item = (icon: IconName, label: string, onClick: () => void, disabled = false) => (
    <button className="menu__item" onClick={onClick} disabled={disabled} style={disabled ? { opacity: 0.4 } : undefined}>
      <Icon name={icon} size={13} />
      <span>{copied === label ? "Copied" : label}</span>
    </button>
  );

  return (
    <div
      ref={ref}
      className="menu__panel threadmenu"
      style={
        props.position
          ? { position: "fixed", left: props.position.x, top: props.position.y, right: "auto" }
          : undefined
      }
    >
      {item("pin", props.pinned ? "Unpin task" : "Pin task", () => act("pin"))}
      {item("pencil", "Rename task", () => act("rename"))}
      {item("archive", "Archive task", () => act("archive"))}
      {item("dots", "Mark as unread", () => act("unread"))}
      <div className="modelmenu__rule" />
      {item(
        "folder",
        "Open in file manager",
        () => {
          if (props.workspaceRoot) window.deyin.shell.showItem(props.workspaceRoot);
          props.onClose();
        },
        !isDesktop || !props.workspaceRoot,
      )}
      {item("copy", "Copy path", () => copy("Copy path", props.workspaceRoot ?? ""), !props.workspaceRoot)}
      {item("copy", "Copy task path", () => copy("Copy task path", taskPath))}
      {item("copy", "Copy log path", () => copy("Copy log path", logPath), !isDesktop)}
      {item("copy", "Copy session ID", () => copy("Copy session ID", props.threadId))}
      {item(
        "gear",
        "Go to config",
        () => {
          if (isDesktop && paths) window.deyin.shell.showItem(paths.config);
          props.onClose();
        },
        !isDesktop,
      )}
      <div className="modelmenu__rule" />
      {item("route", "View model trajectory", () => act("trajectory"))}
      {item("shield", diagLabel, sendDiagnostics, !isDesktop || diagState === "sending")}
      {item("flag", "Report issue", () => {
        const url = "https://github.com/deyin-app/deyin/issues/new";
        if (isDesktop) window.deyin.shell.openExternal(url);
        else window.open(url, "_blank", "noopener");
        props.onClose();
      })}
    </div>
  );
}
