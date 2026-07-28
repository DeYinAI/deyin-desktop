import { createElement, useEffect, useMemo, useState } from "react";
import { themeByName } from "../code.js";
import { computeLineDiff, type FileDiff } from "../diff.js";
import { Icon } from "./Icon.js";
import { Markdown } from "./Markdown.js";

export type PanelTab = "plan" | "diff" | "browser";

export interface CodeDisplaySettings {
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  codeFontSize: number;
  /** Code theme routing for markdown rendered inside the panel (Plan tab). */
  themeLight?: string;
  themeDark?: string;
  variant?: "light" | "dark";
}

interface WorkspacePanelProps {
  platform: "desktop" | "web";
  projectName: string;
  activeTab: PanelTab;
  planMarkdown: string;
  diff: FileDiff | null;
  browserUrl: string;
  /** Per-workspace persistent session partition (cookies survive restarts). */
  browserPartition: string | null;
  codeDisplay: CodeDisplaySettings;
  browserControlEnabled: boolean;
  onSelectTab: (tab: PanelTab) => void;
  onNavigate: (url: string) => void;
  onCollapse: () => void;
  onOpenBrowserSettings?: () => void;
}

/** Right-hand workspace panel: agent plan, latest diff, built-in browser. */
export function WorkspacePanel(props: WorkspacePanelProps) {
  return (
    <section className="wspanel">
      <div className="wspanel__tabs">
        <button className="icon-btn icon-btn--small" title="Collapse panel" onClick={props.onCollapse}>
          <Icon name="chevronsRight" size={13} />
        </button>
        <TabButton label="Plan" active={props.activeTab === "plan"} onClick={() => props.onSelectTab("plan")} />
        <TabButton
          label={props.diff ? props.diff.fileName : "Diff"}
          badge={props.diff ? "Diff" : undefined}
          dot={Boolean(props.diff)}
          active={props.activeTab === "diff"}
          onClick={() => props.onSelectTab("diff")}
        />
        <TabButton label="Browser" active={props.activeTab === "browser"} onClick={() => props.onSelectTab("browser")} />
      </div>

      {props.activeTab === "plan" && <PlanTab markdown={props.planMarkdown} display={props.codeDisplay} />}
      {props.activeTab === "diff" && (
        <DiffTab projectName={props.projectName} diff={props.diff} display={props.codeDisplay} />
      )}
      {props.activeTab === "browser" && (
        <BrowserTab
          platform={props.platform}
          url={props.browserUrl}
          partition={props.browserPartition}
          controlEnabled={props.browserControlEnabled}
          onNavigate={props.onNavigate}
          onOpenBrowserSettings={props.onOpenBrowserSettings}
        />
      )}
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

function PlanTab({ markdown, display }: { markdown: string; display: CodeDisplaySettings }) {
  if (markdown.trim() === "") {
    return <div className="wspanel__body wspanel__empty">No plan yet. Run a task in Plan mode and the proposed plan lands here.</div>;
  }
  const variant = display.variant ?? "dark";
  return (
    <div className="wspanel__body plan-doc">
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
  );
}

/* Diff tab ------------------------------------------------------------------ */

function DiffTab({
  projectName,
  diff,
  display,
}: {
  projectName: string;
  diff: FileDiff | null;
  display: CodeDisplaySettings;
}) {
  const [sourcePreview, setSourcePreview] = useState(false);
  const lines = useMemo(() => (diff ? computeLineDiff(diff.before, diff.after) : []), [diff]);

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
