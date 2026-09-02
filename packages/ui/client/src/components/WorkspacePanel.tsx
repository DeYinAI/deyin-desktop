import {
  lazy,
  Suspense,
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { themeByName } from "../code.js";
import {
  computeLineDiff,
  computeSideBySideDiff,
  type FileDiff,
  type SideBySideRow,
} from "../diff.js";
import { useT } from "../i18n.js";
import { FilesTab } from "./FilesTab.js";
import { GitTab } from "./GitTab.js";
import { SecurityFindingsPanel } from "./SecurityFindingsPanel.js";
import { SubagentPanel, type SubagentEvent } from "./SubagentPanel.js";
import type { AttachableTerminal } from "./TerminalPanel.js";
// xterm is large and only needed when the terminal tab opens; keep it out of the
// initial chunk via a lazy boundary.
const TerminalPanel = lazy(() => import("./TerminalPanel.js").then((m) => ({ default: m.TerminalPanel })));
import { Icon } from "./Icon.js";
import { panelTabDef } from "./panelTabs.js";
import { Markdown } from "./Markdown.js";
import { TodoRows, countVisibleTodos, todosToDisplay } from "./TodoChecklist.js";
import type { CodeDisplaySettings, PanelTab } from "./panelTypes.js";
import type { AgentTodoItem, EnvInfo } from "@deyin/contract";

export type { CodeDisplaySettings, PanelTab } from "./panelTypes.js";

interface WorkspacePanelProps {
  platform: "desktop" | "web";
  projectName: string;
  workspaceRoot: string | null;
  /** Bumped when the sandbox content changes outside root switches (repo connect). */
  filesRefreshKey?: number;
  activeTab: PanelTab;
  /** Active chat thread (drives the Security tab). */
  threadId?: string | null;
  /** Pending change-review queue for the active thread (Diff tab banner). */
  pendingReview?: import("@deyin/contract").PendingChange[];
  onApproveChange?: (changeId: string) => void;
  onRejectChange?: (changeId: string) => void;
  /** Reveal a file in the Files tab (security findings jump-to-file). */
  onOpenFile?: (path: string) => void;
  /** Files tab open request (path + seq so repeat clicks re-open). */
  filesOpenRequest?: { path: string; seq: number } | null;
  planMarkdown: string;
  /** One-page website artifact for the Preview tab. */
  pageTitle?: string;
  pageFileName?: string;
  /** Structured todos for the Plan tab footer (from thread.todos). */
  planTodos?: AgentTodoItem[];
  /** True while the agent run for the active thread is streaming. */
  planTodosRunning?: boolean;
  /** Whether Build can be started from the plan toolbar. */
  canBuildPlan?: boolean;
  diff: FileDiff | null;
  browserUrl: string;
  /** Per-workspace persistent session partition (cookies survive restarts). */
  browserPartition: string | null;
  codeDisplay: CodeDisplaySettings;
  browserControlEnabled: boolean;
  /** Open a git file diff in the Diff tab. */
  onOpenGitDiff?: (diff: FileDiff) => void;
  onNavigate: (url: string) => void;
  onCollapse: () => void;
  onOpenFolder?: () => void;
  onOpenBrowserSettings?: () => void;
  onBuildPlan?: () => void;
  /** Persist manual edits to the plan todo list (idle only). */
  onPlanTodosChange?: (todos: AgentTodoItem[]) => void;
  /** Subagent runs in the active thread (Agent tab), oldest first. */
  subagentRuns?: SubagentEvent[];
  /** Which subagent run the Agent tab shows; null = the newest. */
  selectedSubagentId?: string | null;
  onSelectSubagent?: (id: string) => void;
  /** Terminal tab (desktop/web with PTY support). */
  terminalEnv?: EnvInfo | null;
  terminalDefaultShell?: string | null;
  terminalFontSize?: number;
  terminalScrollback?: number;
  terminalCursorStyle?: "bar" | "block" | "underline";
  terminalCopyOnSelect?: boolean;
  terminalTheme?: "light" | "dark";
  terminalAttachSessions?: AttachableTerminal[];
  /** Right panel width in px (terminal refit on drag). */
  panelWidth?: number | null;
}

/** Right-hand workspace panel: files, agent plan, latest diff, built-in browser. */
export function WorkspacePanel(props: WorkspacePanelProps) {
  const subagentRuns = props.subagentRuns ?? [];
  const runningSubagents = subagentRuns.filter((r) => r.status === "running").length;
  // The icon rail to the left is the tab switcher; the header only names the
  // view that rail selected, so the tab list is not drawn twice.
  const tab = panelTabDef(props.activeTab);
  const title =
    props.activeTab === "diff" && props.diff
      ? props.diff.fileName
      : props.activeTab === "preview" && props.pageTitle?.trim()
        ? props.pageTitle.trim()
        : tab.label;
  return (
    <section className="wspanel">
      <div className="wspanel__tabs">
        <button className="icon-btn icon-btn--small" title="Collapse panel" onClick={props.onCollapse}>
          <Icon name="chevronsRight" size={13} />
        </button>
        <div className="wspanel__title">
          <Icon name={tab.icon} size={13} className="wspanel__title-icon" />
          <span className="wspanel__title-text" title={title}>
            {title}
          </span>
          {props.activeTab === "diff" && props.diff && <span className="wstab__badge">Diff</span>}
          {props.activeTab === "agent" && runningSubagents > 0 && (
            <span className="wstab__badge">{runningSubagents}</span>
          )}
        </div>
      </div>

      {/* Keep tab bodies mounted so FilesTab (and others) retain editor/view state across switches. */}
      <div className="wspanel__pane" hidden={props.activeTab !== "files"}>
        <FilesTab
          platform={props.platform}
          active={props.activeTab === "files"}
          workspaceRoot={props.workspaceRoot}
          refreshKey={props.filesRefreshKey}
          openRequest={props.filesOpenRequest}
          codeDisplay={props.codeDisplay}
          onOpenFolder={props.onOpenFolder}
        />
      </div>
      <div className="wspanel__pane" hidden={props.activeTab !== "terminal"}>
        <Suspense fallback={null}>
        <TerminalPanel
          embedded
          active={props.activeTab === "terminal"}
          panelWidth={props.panelWidth}
          cwd={props.workspaceRoot}
          env={props.terminalEnv ?? null}
          defaultShell={props.terminalDefaultShell ?? null}
          fontSize={props.terminalFontSize ?? 12}
          scrollback={props.terminalScrollback ?? 5000}
          cursorStyle={props.terminalCursorStyle ?? "bar"}
          copyOnSelect={props.terminalCopyOnSelect ?? true}
          theme={props.terminalTheme ?? "dark"}
          attachSessions={props.terminalAttachSessions}
        />
        </Suspense>
      </div>
      <div className="wspanel__pane" hidden={props.activeTab !== "plan"}>
        <PlanTab
          active={props.activeTab === "plan"}
          markdown={props.planMarkdown}
          display={props.codeDisplay}
          todos={props.planTodos ?? []}
          running={props.planTodosRunning ?? false}
          canBuild={props.canBuildPlan ?? false}
          onBuild={props.onBuildPlan}
          onTodosChange={props.onPlanTodosChange}
        />
      </div>
      <div className="wspanel__pane" hidden={props.activeTab !== "preview"}>
        <PreviewTab
          active={props.activeTab === "preview"}
          threadId={props.threadId ?? null}
          title={props.pageTitle}
          fileName={props.pageFileName}
        />
      </div>
      <div className="wspanel__pane" hidden={props.activeTab !== "diff"}>
        <DiffTab projectName={props.projectName} diff={props.diff} display={props.codeDisplay} />
      </div>
      <div className="wspanel__pane" hidden={props.activeTab !== "git"}>
        <GitTab
          active={props.activeTab === "git"}
          workspaceRoot={props.workspaceRoot}
          onOpenDiff={(d) => props.onOpenGitDiff?.(d)}
        />
      </div>
      <div className="wspanel__pane" hidden={props.activeTab !== "browser"}>
        <BrowserTab
          platform={props.platform}
          url={props.browserUrl}
          partition={props.browserPartition}
          controlEnabled={props.browserControlEnabled}
          onNavigate={props.onNavigate}
          onOpenBrowserSettings={props.onOpenBrowserSettings}
        />
      </div>
      <div className="wspanel__pane" hidden={props.activeTab !== "security"}>
        <SecurityFindingsPanel
          active={props.activeTab === "security"}
          threadId={props.threadId ?? null}
          workspaceRoot={props.workspaceRoot}
          onOpenFile={props.onOpenFile ? (path: string) => props.onOpenFile?.(path) : undefined}
        />
      </div>
      <div className="wspanel__pane" hidden={props.activeTab !== "agent"}>
        <SubagentPanel
          active={props.activeTab === "agent"}
          runs={subagentRuns}
          selectedId={props.selectedSubagentId ?? null}
          onSelect={(id) => props.onSelectSubagent?.(id)}
          codeDisplay={props.codeDisplay}
          threadId={props.threadId ?? null}
        />
      </div>
    </section>
  );
}

/* Plan tab ----------------------------------------------------------------- */

function PlanTab({
  active,
  markdown,
  display,
  todos,
  running,
  canBuild,
  onBuild,
  onTodosChange,
}: {
  active: boolean;
  markdown: string;
  display: CodeDisplaySettings;
  todos: AgentTodoItem[];
  running: boolean;
  canBuild: boolean;
  onBuild?: () => void;
  onTodosChange?: (todos: AgentTodoItem[]) => void;
}) {
  const t = useT();
  const empty = markdown.trim() === "";

  useEffect(() => {
    if (!active || !canBuild || !onBuild) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
      e.preventDefault();
      onBuild();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, canBuild, onBuild]);

  if (empty) {
    return <div className="wspanel__body wspanel__empty">No plan yet. Run a task in Plan mode and the proposed plan lands here.</div>;
  }

  const variant = display.variant ?? "dark";
  return (
    <div className="plan-tab">
      <div className="plan-tab__toolbar">
        <span className="plan-tab__title">{t("chat.planSummary")}</span>
        <span className="plan-tab__toolbar-spacer" />
        {onBuild && (
          <button type="button" className="plan-tab__build" disabled={!canBuild} onClick={onBuild} title={`${t("chat.build")} (Ctrl+Enter)`}>
            <Icon name="play" size={11} />
            {t("chat.build")}
            <span className="plan-tab__shortcut">Ctrl+↵</span>
          </button>
        )}
      </div>
      <div className="plan-doc wspanel__body">
        <Markdown
          text={markdown}
          theme={themeByName(
            variant === "light" ? (display.themeLight ?? "GitHub Light") : (display.themeDark ?? "GitHub Dark"),
            variant,
          )}
          display={{
            themeLight: display.themeLight ?? "GitHub Light",
            themeDark: display.themeDark ?? "GitHub Dark",
            variant,
            fontSize: display.codeFontSize,
            showLineNumbers: display.showLineNumbers,
            wrapLongLines: display.wrapLongLines,
          }}
        />
      </div>
      <PlanTodosFooter todos={todos} running={running} onTodosChange={onTodosChange} />
    </div>
  );
}

function PlanTodosFooter({
  todos,
  running,
  onTodosChange,
}: {
  todos: AgentTodoItem[];
  running: boolean;
  onTodosChange?: (todos: AgentTodoItem[]) => void;
}) {
  const t = useT();
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { visible } = countVisibleTodos(todos);
  const editable = Boolean(onTodosChange) && !running;

  useEffect(() => {
    if (drafting) inputRef.current?.focus();
  }, [drafting]);

  const commitDraft = () => {
    const content = draft.trim();
    if (!content || !onTodosChange) {
      setDrafting(false);
      setDraft("");
      return;
    }
    const id = `manual-${Date.now().toString(36)}`;
    onTodosChange([...todos, { id, content, status: "pending" }]);
    setDraft("");
    setDrafting(false);
  };

  const toggleTodo = (id: string) => {
    if (!onTodosChange || running) return;
    onTodosChange(
      todos.map((todo) => {
        if (todo.id !== id) return todo;
        if (todo.status === "completed") return { ...todo, status: "pending" };
        if (todo.status === "pending") return { ...todo, status: "completed" };
        return todo;
      }),
    );
  };

  return (
    <div className="plan-todos">
      <div className="plan-todos__head">
        <span className="plan-todos__title">
          {visible} {t("tasks.todos")}
        </span>
        <button
          type="button"
          className="plan-todos__new"
          disabled={!editable}
          onClick={() => {
            setDrafting(true);
            setDraft("");
          }}
        >
          <Icon name="plus" size={11} />
          {t("tasks.new")}
        </button>
      </div>
      <div className="plan-todos__body">
        {drafting && (
          <div className="plan-todos__composer">
            <span className="todo-indicator todo-indicator--pending" aria-hidden="true" />
            <input
              ref={inputRef}
              className="plan-todos__input"
              value={draft}
              placeholder={t("tasks.newPlaceholder")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitDraft();
                }
                if (e.key === "Escape") {
                  setDrafting(false);
                  setDraft("");
                }
              }}
              onBlur={() => {
                if (draft.trim()) commitDraft();
                else {
                  setDrafting(false);
                  setDraft("");
                }
              }}
            />
          </div>
        )}
        {todos.length === 0 && !drafting ? (
          <div className="plan-todos__empty">{t("tasks.empty")}</div>
        ) : (
          <TodoRows items={todosToDisplay(todos)} running={running} onToggle={editable ? toggleTodo : undefined} />
        )}
      </div>
    </div>
  );
}

/* Diff tab ------------------------------------------------------------------ */

type DiffViewMode = "split" | "unified";

function DiffTab({
  projectName,
  diff,
  display,
}: {
  projectName: string;
  diff: FileDiff | null;
  display: CodeDisplaySettings;
}) {
  const t = useT();
  const [view, setView] = useState<DiffViewMode>("split");
  const [sourcePreview, setSourcePreview] = useState(false);
  // Both views come from the same LCS walk, so compute them together.
  const { rows, lines } = useMemo(
    () => ({
      rows: diff ? computeSideBySideDiff(diff.before, diff.after) : [],
      lines: diff ? computeLineDiff(diff.before, diff.after) : [],
    }),
    [diff],
  );

  if (!diff) {
    return <div className="wspanel__body wspanel__empty">No changes yet. Edits made by the agent show up here.</div>;
  }

  const textStyle = display.wrapLongLines
    ? undefined
    : ({ whiteSpace: "pre", wordBreak: "normal" } as const);

  const sep = Math.max(diff.fileName.lastIndexOf("/"), diff.fileName.lastIndexOf("\\"));
  const fileDir = sep >= 0 ? diff.fileName.slice(0, sep + 1) : "";
  const fileBase = sep >= 0 ? diff.fileName.slice(sep + 1) : diff.fileName;
  // "" is an empty file, so these say "there is no other version", not "the
  // diff failed" — which is how a blank pane reads.
  const isNewFile = diff.before === "";
  const isDeletedFile = diff.after === "";

  return (
    <>
      <div className="wspanel__subbar">
        <span className="crumb crumb--project">{projectName}</span>
        <Icon name="chevronRight" size={11} />
        {/* The directory is what gives when the panel is narrow; the file name
            always stays readable, and the title carries the full path. */}
        <span className="crumb crumb--file" title={diff.fileName}>
          <Icon name="file" size={12} />
          {fileDir && <span className="crumb__dir">{fileDir}</span>}
          <span className="crumb__name">{fileBase}</span>
        </span>
        <div className="wspanel__subbar-spacer" />
        <div className="diff-view-toggle" role="group" aria-label="Diff layout">
          <button
            type="button"
            className={`diff-view-toggle__btn ${view === "split" ? "diff-view-toggle__btn--active" : ""}`}
            onClick={() => setView("split")}
          >
            {t("diff.viewSplit")}
          </button>
          <button
            type="button"
            className={`diff-view-toggle__btn ${view === "unified" ? "diff-view-toggle__btn--active" : ""}`}
            onClick={() => setView("unified")}
          >
            {t("diff.viewUnified")}
          </button>
        </div>
        <button
          className={`chip chip--small ${sourcePreview ? "chip--active" : ""}`}
          title="Show the new file as plain source"
          onClick={() => setSourcePreview((v) => !v)}
        >
          Source preview
        </button>
      </div>
      <div className="wspanel__body code-view" style={{ fontSize: display.codeFontSize }}>
        {sourcePreview ? (
          <pre className="code-pre" style={textStyle}>{diff.after}</pre>
        ) : view === "split" ? (
          <table className="diff-table diff-table--split">
            {/* table-layout is fixed, and with only colSpan headers in the first
                row the four columns would split the width evenly — giving each
                line-number gutter a quarter of the panel. State the widths. */}
            <colgroup>
              <col className={display.showLineNumbers ? "diff-col-no" : "diff-col-sign"} />
              <col />
              <col className={display.showLineNumbers ? "diff-col-no" : "diff-col-sign"} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th className="diff-head diff-head--del" colSpan={2}>
                  Old{isNewFile && <span className="diff-head__note">new file</span>}
                </th>
                <th className="diff-head diff-head--add" colSpan={2}>
                  New{isDeletedFile && <span className="diff-head__note">deleted</span>}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="diff-row diff-split-row">
                  <SplitCell cell={row.left} side="left" showLineNumbers={display.showLineNumbers} textStyle={textStyle} />
                  <SplitCell cell={row.right} side="right" showLineNumbers={display.showLineNumbers} textStyle={textStyle} />
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="diff-table">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className={`diff-row diff-row--${line.type}`}>
                  {display.showLineNumbers && <td className="diff-no">{line.oldNo ?? ""}</td>}
                  {display.showLineNumbers && <td className="diff-no">{line.newNo ?? ""}</td>}
                  <td className="diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : ""}</td>
                  <td className="diff-text" style={textStyle}>{line.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function SplitCell({
  cell,
  side,
  showLineNumbers,
  textStyle,
}: {
  cell: SideBySideRow["left"];
  side: "left" | "right";
  showLineNumbers: boolean;
  textStyle: CSSProperties | undefined;
}) {
  const empty = cell.type === "empty";
  const sign = cell.type === "add" ? "+" : cell.type === "del" ? "-" : "";
  return (
    <>
      {showLineNumbers && (
        <td className={`diff-no diff-no--${side}`}>{cell.no ?? ""}</td>
      )}
      {!showLineNumbers && <td className="diff-sign">{sign}</td>}
      <td
        className={`diff-text diff-text--${side} ${empty ? "diff-text--empty" : `diff-cell--${cell.type}`}`}
        style={textStyle}
      >
        {cell.text}
      </td>
    </>
  );
}

/* Preview tab (one-page website artifacts) --------------------------------- */

function encodeSrcdoc(html: string): string {
  return html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function PreviewTab({
  active,
  threadId,
  title,
  fileName,
}: {
  active: boolean;
  threadId: string | null;
  title?: string;
  fileName?: string;
}) {
  const t = useT();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !threadId || !fileName?.trim()) {
      setHtml(null);
      setError(null);
      return;
    }
    let cancelled = false;
    void window.deyin.page
      .read(threadId, fileName)
      .then((content) => {
        if (!cancelled) {
          setHtml(content);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [active, threadId, fileName]);

  const srcdoc = html ? encodeSrcdoc(html) : null;
  const heading = title?.trim() || fileName?.trim();

  return (
    <>
      {heading && (
        <div className="wspanel__subbar">
          <Icon name="layout" size={13} />
          <span className="wspanel__title-text">{heading}</span>
        </div>
      )}
      <div className="wspanel__body wspanel__browser">
        {!fileName?.trim() && <div className="hint">{t("preview.empty")}</div>}
        {error && <div className="hint hint--bad">{error}</div>}
        {fileName?.trim() && !error && !srcdoc && <div className="hint">{t("preview.loading")}</div>}
        {srcdoc && (
          <iframe
            className="preview-frame"
            title={heading ?? "Preview"}
            sandbox="allow-scripts allow-same-origin allow-forms"
            srcDoc={srcdoc}
          />
        )}
      </div>
    </>
  );
}

/* Browser tab ---------------------------------------------------------------- */

function BrowserTab({
  platform,
  url,
  partition,
  controlEnabled,
  onNavigate,
  onOpenBrowserSettings,
}: {
  platform: "desktop" | "web";
  url: string;
  partition: string | null;
  controlEnabled: boolean;
  onNavigate: (url: string) => void;
  onOpenBrowserSettings?: () => void;
}) {
  const [input, setInput] = useState(url);
  useEffect(() => setInput(url), [url]);

  const go = () => {
    let target = input.trim();
    if (target && !/^https?:\/\//.test(target)) target = `https://${target}`;
    if (target) onNavigate(target);
  };

  return (
    <>
      <div className="wspanel__subbar">
        <Icon name="globe" size={13} />
        <input
          className="urlbar"
          value={input}
          placeholder="Enter a URL"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
          }}
        />
        <button className="chip chip--small" onClick={go}>
          Go
        </button>
        <button
          className={`chip chip--small ${controlEnabled ? "chip--on" : ""}`}
          title="Browser control lets agent sessions drive this tab. Click to change in settings."
          onClick={onOpenBrowserSettings}
        >
          Control {controlEnabled ? "on" : "off"}
        </button>
      </div>
      <div className="wspanel__body wspanel__browser">
        {url ? (
          platform === "desktop" ? (
            // Electron's webview tag is absent from DOM typings; create it untyped.
            // key remounts the view when the partition changes (Electron forbids
            // changing the partition of a live webview).
            createElement("webview", {
              key: partition ?? "default",
              src: url,
              style: { width: "100%", height: "100%" },
              ...(partition ? { partition } : {}),
              ref: registerControlledWebview,
            })
          ) : (
            <iframe src={url} title="Preview" sandbox="allow-scripts allow-same-origin allow-forms" />
          )
        ) : (
          <div className="wspanel__empty">Built-in browser. Agent sessions can open and control pages here.</div>
        )}
      </div>
    </>
  );
}

/* Browser control: the workspace <webview> registers with the main process,
 * where the agent's browser_* tools drive it over CDP (navigate, click, type,
 * screenshot, console/network logs). */

interface ControlledWebview extends HTMLElement {
  getWebContentsId?(): number;
}

let registeredWebview: ControlledWebview | null = null;

function registerControlledWebview(el: unknown): void {
  const view = (el as ControlledWebview) ?? null;
  if (!view) {
    // Unmounting: tell main the target is gone.
    registeredWebview = null;
    window.deyin.browserControl?.register(null);
    return;
  }
  if (view === registeredWebview) return;
  registeredWebview = view;
  const announce = () => {
    try {
      const id = view.getWebContentsId?.();
      if (typeof id === "number") window.deyin.browserControl?.register(id);
    } catch {
      // Webview not attached yet; the dom-ready listener retries.
    }
  };
  view.addEventListener("dom-ready", announce);
  announce();
}
