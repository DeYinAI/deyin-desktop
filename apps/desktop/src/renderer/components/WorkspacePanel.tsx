import { createElement, useEffect, useMemo, useRef, useState } from "react";
import { themeByName } from "../code.js";
import { computeLineDiff, type FileDiff } from "../diff.js";
import { useT } from "../i18n.js";
import { FilesTab } from "./FilesTab.js";
import { GitTab } from "./GitTab.js";
import { SecurityFindingsPanel } from "./SecurityFindingsPanel.js";
import { Icon } from "./Icon.js";
import { Markdown } from "./Markdown.js";
import { TodoRows, countVisibleTodos, todosToDisplay } from "./TodoChecklist.js";
import type { CodeDisplaySettings, PanelTab } from "./panelTypes.js";
import type { AgentTodoItem, PendingChange } from "../../shared/types.js";

export type { CodeDisplaySettings, PanelTab } from "./panelTypes.js";

interface WorkspacePanelProps {
  platform: "desktop" | "web";
  projectName: string;
  workspaceRoot: string | null;
  activeTab: PanelTab;
  planMarkdown: string;
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
  onSelectTab: (tab: PanelTab) => void;
  onNavigate: (url: string) => void;
  onCollapse: () => void;
  onOpenFolder?: () => void;
  onOpenBrowserSettings?: () => void;
  onBuildPlan?: () => void;
  /** Persist manual edits to the plan todo list (idle only). */
  onPlanTodosChange?: (todos: AgentTodoItem[]) => void;
  /** Pending file changes awaiting review (Diff tab actions). */
  pendingReview?: PendingChange[];
  onApproveChange?: (changeId: string) => void;
  onRejectChange?: (changeId: string) => void;
  /** Active chat thread — drives Security tab findings storage. */
  threadId?: string | null;
  onOpenFile?: (path: string) => void;
}

/** Right-hand workspace panel: files, agent plan, latest diff, built-in browser. */
export function WorkspacePanel(props: WorkspacePanelProps) {
  return (
    <section className="wspanel">
      <div className="wspanel__tabs">
        <button className="icon-btn icon-btn--small" title="Collapse panel" onClick={props.onCollapse}>
          <Icon name="chevronsRight" size={13} />
        </button>
        <TabButton label="Files" active={props.activeTab === "files"} onClick={() => props.onSelectTab("files")} />
        <TabButton label="Plan" active={props.activeTab === "plan"} onClick={() => props.onSelectTab("plan")} />
        <TabButton
          label={props.diff ? props.diff.fileName : "Diff"}
          badge={props.diff ? "Diff" : undefined}
          dot={Boolean(props.diff)}
          active={props.activeTab === "diff"}
          onClick={() => props.onSelectTab("diff")}
        />
        <TabButton label="Browser" active={props.activeTab === "browser"} onClick={() => props.onSelectTab("browser")} />
        <TabButton label="Git" active={props.activeTab === "git"} onClick={() => props.onSelectTab("git")} />
        <TabButton label="Security" active={props.activeTab === "security"} onClick={() => props.onSelectTab("security")} />
      </div>

      {/* Keep tab bodies mounted so FilesTab (and others) retain editor/view state across switches. */}
      <div className="wspanel__pane" hidden={props.activeTab !== "files"}>
        <FilesTab
          platform={props.platform}
          active={props.activeTab === "files"}
          workspaceRoot={props.workspaceRoot}
          codeDisplay={props.codeDisplay}
          onOpenFolder={props.onOpenFolder}
        />
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
      <div className="wspanel__pane" hidden={props.activeTab !== "diff"}>
        <DiffTab
          projectName={props.projectName}
          diff={props.diff}
          display={props.codeDisplay}
          pendingReview={props.pendingReview}
          onApproveChange={props.onApproveChange}
          onRejectChange={props.onRejectChange}
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
      <div className="wspanel__pane" hidden={props.activeTab !== "git"}>
        <GitTab
          active={props.activeTab === "git"}
          workspaceRoot={props.workspaceRoot}
          codeDisplay={props.codeDisplay}
          threadId={props.threadId}
          onScanComplete={() => props.onSelectTab("security")}
        />
      </div>
      <div className="wspanel__pane" hidden={props.activeTab !== "security"}>
        <SecurityFindingsPanel
          active={props.activeTab === "security"}
          threadId={props.threadId ?? null}
          workspaceRoot={props.workspaceRoot}
          onOpenFile={props.onOpenFile}
        />
      </div>
    </section>
  );
}

function TabButton(props: { label: string; active: boolean; badge?: string; dot?: boolean; onClick: () => void }) {
  return (
    <button className={`wstab ${props.active ? "wstab--active" : ""}`} onClick={props.onClick}>
      {props.dot && <span className="wstab__dot" />}
      <span className="wstab__label">{props.label}</span>
      {props.badge && <span className="wstab__badge">{props.badge}</span>}
    </button>
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

function DiffTab({
  projectName,
  diff,
  display,
  pendingReview,
  onApproveChange,
  onRejectChange,
}: {
  projectName: string;
  diff: FileDiff | null;
  display: CodeDisplaySettings;
  pendingReview?: PendingChange[];
  onApproveChange?: (changeId: string) => void;
  onRejectChange?: (changeId: string) => void;
}) {
  const [sourcePreview, setSourcePreview] = useState(false);
  const lines = useMemo(() => (diff ? computeLineDiff(diff.before, diff.after) : []), [diff]);
  const pendingForFile = useMemo(
    () =>
      diff && pendingReview
        ? pendingReview.find((c) => c.status === "pending" && c.path === diff.fileName)
        : undefined,
    [diff, pendingReview],
  );

  if (!diff) {
    return <div className="wspanel__body wspanel__empty">No changes yet. Edits made by the agent show up here.</div>;
  }

  const textStyle = display.wrapLongLines
    ? undefined
    : ({ whiteSpace: "pre", wordBreak: "normal" } as const);

  return (
    <>
      <div className="wspanel__subbar">
        <span className="crumb">{projectName}</span>
        <Icon name="chevronRight" size={11} />
        <span className="crumb crumb--file">
          <Icon name="file" size={12} />
          {diff.fileName}
        </span>
        <div className="wspanel__subbar-spacer" />
        {pendingForFile && onApproveChange && onRejectChange ? (
          <div className="diff-review-actions">
            <button type="button" className="btn btn--primary btn--sm" onClick={() => onApproveChange(pendingForFile.id)}>
              Accept
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onRejectChange(pendingForFile.id)}>
              Reject
            </button>
          </div>
        ) : null}
        <button
          className={`chip chip--small ${sourcePreview ? "chip--active" : ""}`}
          onClick={() => setSourcePreview((v) => !v)}
        >
          Source preview
        </button>
      </div>
      <div className="wspanel__body code-view" style={{ fontSize: display.codeFontSize }}>
        {sourcePreview ? (
          <pre className="code-pre" style={textStyle}>{diff.after}</pre>
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

/* Browser tab ---------------------------------------------------------------- */

const MAX_BROWSER_TABS = 8;

interface BrowserTabState {
  key: string;
  url: string;
  title: string;
  wcId: number | null;
}

function newBrowserTab(url = "about:blank"): BrowserTabState {
  return { key: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, url, title: "New Tab", wcId: null };
}

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
  const [tabs, setTabs] = useState<BrowserTabState[]>(() => [newBrowserTab(url || "about:blank")]);
  const [activeKey, setActiveKey] = useState(() => tabs[0]?.key ?? "");
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTab = tabs.find((t) => t.key === activeKey) ?? tabs[0];

  const [input, setInput] = useState(activeTab?.url ?? url);
  useEffect(() => {
    if (!url) return;
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.key === activeKey);
      if (idx < 0) return prev;
      const current = prev[idx];
      if (!current) return prev;
      const next = [...prev];
      next[idx] = { ...current, url };
      return next;
    });
  }, [url, activeKey]);

  useEffect(() => setInput(activeTab?.url ?? ""), [activeTab?.url]);

  const activateTab = (key: string) => {
    setActiveKey(key);
    const tab = tabs.find((t) => t.key === key);
    if (tab?.wcId != null) window.deyin.browserControl?.register(tab.wcId);
  };

  const openTab = (targetUrl: string) => {
    if (tabs.length >= MAX_BROWSER_TABS) return;
    const tab = newBrowserTab(targetUrl);
    setTabs((prev) => [...prev, tab]);
    setActiveKey(tab.key);
    onNavigate(targetUrl);
  };

  const closeTab = (key: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) {
        const blank = newBrowserTab("about:blank");
        setActiveKey(blank.key);
        onNavigate("about:blank");
        return [blank];
      }
      const idx = prev.findIndex((t) => t.key === key);
      if (idx < 0) return prev;
      const closing = prev[idx];
      if (!closing) return prev;
      if (closing.wcId != null) window.deyin.browserControl?.removeTab(closing.wcId);
      const next = prev.filter((t) => t.key !== key);
      if (key === activeKey) {
        const fallback = next[Math.min(idx, next.length - 1)] ?? next[0];
        if (fallback) {
          setActiveKey(fallback.key);
          if (fallback.wcId != null) window.deyin.browserControl?.register(fallback.wcId);
          onNavigate(fallback.url);
        }
      }
      return next;
    });
  };

  useEffect(() => {
    if (!window.deyin.browserControl?.onTabCommand) return;
    return window.deyin.browserControl.onTabCommand((cmd) => {
      if (cmd.action === "open") {
        if (tabsRef.current.length >= MAX_BROWSER_TABS) return;
        const tab = newBrowserTab(cmd.url);
        setTabs((prev) => [...prev, tab]);
        setActiveKey(tab.key);
        onNavigate(cmd.url);
        return;
      }
      if (cmd.action === "switch") {
        const match = tabsRef.current.find((t) => t.wcId === cmd.tabId);
        if (match) {
          setActiveKey(match.key);
          window.deyin.browserControl?.register(cmd.tabId);
        }
        return;
      }
      if (cmd.action === "close") {
        const match = tabsRef.current.find((t) => t.wcId === cmd.tabId);
        if (!match) return;
        setTabs((prev) => {
          if (prev.length <= 1) {
            const blank = newBrowserTab("about:blank");
            setActiveKey(blank.key);
            onNavigate("about:blank");
            return [blank];
          }
          const idx = prev.findIndex((t) => t.key === match.key);
          const next = prev.filter((t) => t.key !== match.key);
          window.deyin.browserControl?.removeTab(cmd.tabId);
          if (match.key === activeKey) {
            const fallback = next[Math.min(idx, next.length - 1)] ?? next[0];
            if (fallback) {
              setActiveKey(fallback.key);
              if (fallback.wcId != null) window.deyin.browserControl?.register(fallback.wcId);
              onNavigate(fallback.url);
            }
          }
          return next;
        });
      }
    });
  }, [activeKey, onNavigate]);

  const go = () => {
    let target = input.trim();
    if (target && !/^https?:\/\//.test(target)) target = `https://${target}`;
    if (!target) return;
    onNavigate(target);
    setTabs((prev) =>
      prev.map((t) => (t.key === activeKey ? { ...t, url: target } : t)),
    );
  };

  const updateTabMeta = (key: string, wcId: number, tabUrl: string, title: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.key === key ? { ...t, wcId, url: tabUrl || t.url, title: title || t.title } : t)),
    );
    window.deyin.browserControl?.syncTab(wcId, tabUrl, title);
    if (key === activeKey) window.deyin.browserControl?.register(wcId);
  };

  return (
    <>
      <div className="browser-tabstrip">
        {tabs.map((tab) => (
          <div
            key={tab.key}
            className={`browser-tabstrip__tab ${tab.key === activeKey ? "browser-tabstrip__tab--active" : ""}`}
            onClick={() => activateTab(tab.key)}
            title={tab.url}
          >
            <span className="browser-tabstrip__title">{tab.title || tab.url || "New Tab"}</span>
            {tabs.length > 1 && (
              <button
                type="button"
                className="browser-tabstrip__close"
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.key);
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {tabs.length < MAX_BROWSER_TABS && (
          <button type="button" className="browser-tabstrip__new" title="New tab" onClick={() => openTab("about:blank")}>
            +
          </button>
        )}
      </div>
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
        {tabs.some((t) => t.url) ? (
          platform === "desktop" ? (
            tabs.map((tab) => (
              createElement("webview", {
                key: `${tab.key}:${partition ?? "default"}`,
                src: tab.url,
                style: {
                  width: "100%",
                  height: "100%",
                  flex: 1,
                  display: tab.key === activeKey ? "flex" : "none",
                },
                ...(partition ? { partition } : {}),
                ref: (el: unknown) => registerControlledWebview(el, tab.key, activeKey, updateTabMeta),
              })
            ))
          ) : (
            activeTab?.url ? (
              <iframe src={activeTab.url} title="Preview" sandbox="allow-scripts allow-same-origin allow-forms" />
            ) : null
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
  getURL?(): string;
  getTitle?(): string;
}

const registeredWebviews = new Map<string, ControlledWebview>();

function registerControlledWebview(
  el: unknown,
  tabKey: string,
  activeKey: string,
  onMeta: (tabKey: string, wcId: number, url: string, title: string) => void,
): void {
  const view = (el as ControlledWebview) ?? null;
  if (!view) {
    const prev = registeredWebviews.get(tabKey);
    if (prev) {
      try {
        const id = prev.getWebContentsId?.();
        if (typeof id === "number") window.deyin.browserControl?.removeTab(id);
      } catch {
        // Webview already torn down.
      }
    }
    registeredWebviews.delete(tabKey);
    return;
  }
  if (registeredWebviews.get(tabKey) === view) return;
  registeredWebviews.set(tabKey, view);

  const announce = () => {
    try {
      const id = view.getWebContentsId?.();
      if (typeof id !== "number") return;
      const tabUrl = view.getURL?.() ?? "";
      const title = view.getTitle?.() ?? "New Tab";
      onMeta(tabKey, id, tabUrl, title);
      if (tabKey === activeKey) window.deyin.browserControl?.register(id);
    } catch {
      // Webview not attached yet; the dom-ready listener retries.
    }
  };
  view.addEventListener("dom-ready", announce);
  view.addEventListener("page-title-updated", announce);
  announce();
}
