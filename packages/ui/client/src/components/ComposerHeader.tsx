import { Icon } from "./Icon.js";
import { Logo } from "./Logo.js";

interface ComposerHeaderProps {
  platform: "desktop" | "web";
  projectName: string;
  workspaceRoot: string | null;
  onPickFolder: () => void;
}

/** Slim workspace context row above the composer: folder pill on the left,
 *  brand mark on the right. Folder workspaces are desktop-only. */
export function ComposerHeader({ platform, projectName, workspaceRoot, onPickFolder }: ComposerHeaderProps) {
  return (
    <div className="composer-header">
      {platform === "desktop" ? (
        <button
          type="button"
          className="composer-header__folder"
          onClick={onPickFolder}
          title={workspaceRoot ?? "Choose a folder as your workspace"}
        >
          <Icon name="folder" size={13} />
          <span className="composer-header__folder-name">{projectName}</span>
          <Icon name="chevronDown" size={11} className="composer-header__folder-caret" />
        </button>
      ) : (
        <span aria-hidden />
      )}
      <span className="composer-header__brand">
        <Logo size={13} />
        <span>Deyin</span>
      </span>
    </div>
  );
}
