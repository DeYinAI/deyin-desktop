import { Icon } from "./Icon.js";
import { useGitStatus } from "./GitBranchBadge.js";

interface RepoChipProps {
  workspaceRoot: string | null;
  /** User home dir (Bootstrap.homeDir) for `~`-shortening absolute paths. */
  homeDir?: string | null;
  /** Fallback label when there is no workspace at all. */
  projectName: string;
  /** Folder workspaces are desktop-only; web shows a static label. */
  platform: "desktop" | "web";
  onPickFolder: () => void;
  onOpenSourceControl: () => void;
  /** Web: open the "Connect repository" dialog (clone into the session sandbox). */
  onConnectRepo?: () => void;
}

/** legacy UI-style chip above the composer on the new-chat screen:
 *  folder icon + `~`-shortened repo path | branch. */
export function RepoChip({
  workspaceRoot,
  homeDir,
  projectName,
  platform,
  onPickFolder,
  onOpenSourceControl,
  onConnectRepo,
}: RepoChipProps) {
  const { info } = useGitStatus(workspaceRoot);

  if (!info?.isRepo) {
    // No repo to summarize: keep the folder-picker (desktop) or repo-connect
    // (web) entry point reachable.
    return (
      <div className="repo-chip-row">
        <button
          type="button"
          className="repo-chip"
          onClick={platform === "desktop" ? onPickFolder : onConnectRepo}
          disabled={platform === "desktop" ? false : !onConnectRepo}
        >
          <Icon name={platform === "desktop" ? "folder" : "gitBranch"} size={13} />
          <span className="repo-chip__path">
            {platform === "desktop"
              ? workspaceRoot
                ? projectName
                : "Choose a folder"
              : "Connect a repository"}
          </span>
        </button>
      </div>
    );
  }

  const branch = info.detached ? "detached" : (info.branch ?? "—");

  return (
    <div className="repo-chip-row">
      <button
        type="button"
        className="repo-chip"
        title={workspaceRoot ?? undefined}
        onClick={onOpenSourceControl}
      >
        <Icon name="folder" size={13} />
        <span className="repo-chip__path">{displayPath(workspaceRoot, homeDir)}</span>
        <span className="repo-chip__divider" aria-hidden />
        <Icon name="gitBranch" size={12} />
        <span className="repo-chip__branch">{branch}</span>
      </button>
    </div>
  );
}

/** `~/github/deyin-desktop` when under home; otherwise keep the last two segments. */
function displayPath(root: string | null, homeDir?: string | null): string {
  if (!root) return "";
  const normalized = root.replace(/\\/g, "/");
  const home = homeDir?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (home && (normalized === home || normalized.startsWith(`${home}/`))) {
    return `~${normalized.slice(home.length)}`;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 2) return normalized;
  return `…/${segments.slice(-2).join("/")}`;
}
