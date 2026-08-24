import { useEffect, useRef } from "react";
import { useConfirm } from "./ConfirmDialog.js";
import { useT } from "../i18n.js";
import { Icon, type IconName } from "./Icon.js";

export type ProjectAction = "remove";

interface ProjectMenuProps {
  projectName: string;
  /** Non-archived chats shown under this project. */
  chatCount: number;
  platform: "desktop" | "web";
  workspaceRoot: string | null;
  /** Fixed screen position (context menu); omitted when anchored to a button. */
  position?: { x: number; y: number };
  onAction: (action: ProjectAction) => void;
  onClose: () => void;
}

/** Context menu for a sidebar project/folder group. */
export function ProjectMenu(props: ProjectMenuProps) {
  const t = useT();
  const { confirm } = useConfirm();
  const ref = useRef<HTMLDivElement>(null);
  const isDesktop = props.platform === "desktop";

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

  const act = (action: ProjectAction) => {
    props.onAction(action);
    props.onClose();
  };

  const remove = () => {
    void (async () => {
      if (props.chatCount > 0) {
        const ok = await confirm({
          message: t("nav.removeProjectConfirm").replace("{name}", props.projectName),
          destructive: true,
        });
        if (!ok) return;
      }
      act("remove");
    })();
  };

  const item = (icon: IconName, label: string, onClick: () => void, disabled = false) => (
    <button className="menu__item" onClick={onClick} disabled={disabled} style={disabled ? { opacity: 0.4 } : undefined}>
      <Icon name={icon} size={13} />
      <span>{label}</span>
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
      {item(
        "folder",
        "Open in file manager",
        () => {
          if (props.workspaceRoot) window.deyin.shell.showItem(props.workspaceRoot);
          props.onClose();
        },
        !isDesktop || !props.workspaceRoot,
      )}
      {item("copy", "Copy path", () => {
        void navigator.clipboard.writeText(props.workspaceRoot ?? "").then(props.onClose);
      }, !props.workspaceRoot)}
      <div className="modelmenu__rule" />
      {item("trash", t("nav.removeProject"), remove)}
    </div>
  );
}
