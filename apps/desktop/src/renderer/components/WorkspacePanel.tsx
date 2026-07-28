import { createElement, useEffect, useMemo, useState } from "react";
import { computeLineDiff, type FileDiff } from "../diff.js";
import { Icon } from "./Icon.js";

export type PanelTab = "plan" | "diff" | "browser";

export interface CodeDisplaySettings {
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  codeFontSize: number;
}

interface WorkspacePanelProps {
  platform: "desktop" | "web";
  projectName: string;
  activeTab: PanelTab;
  planMarkdown: string;
  diff: FileDiff | null;
  browserUrl: string;
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

      {props.activeTab === "plan" && <PlanTab markdown={props.planMarkdown} />}
      {props.activeTab === "diff" && (
        <DiffTab projectName={props.projectName} diff={props.diff} display={props.codeDisplay} />
      )}
      {props.activeTab === "browser" && (
        <BrowserTab
          platform={props.platform}
          url={props.browserUrl}
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

function PlanTab({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => markdown.split("\n"), [markdown]);
  if (markdown.trim() === "") {
    return <div className="wspanel__body wspanel__empty">No plan yet. The agent posts its working plan here as it executes.</div>;
  }
  return (
    <div className="wspanel__body plan-doc">
      {blocks.map((line, i) => {
        if (line.startsWith("## ")) return <h3 key={i}>{line.slice(3)}</h3>;
        if (line.startsWith("# ")) return <h2 key={i}>{line.slice(2)}</h2>;
        const check = /^- \[( |x)\] (.*)$/.exec(line);
        if (check) {
          const done = check[1] === "x";
          return (
            <div className="plan-step" key={i}>
              <span className={`plan-step__box ${done ? "plan-step__box--done" : ""}`}>
                {done && <Icon name="check" size={10} />}
              </span>
              <span className={done ? "plan-step__text plan-step__text--done" : "plan-step__text"}>{check[2]}</span>
            </div>
          );
        }
        if (line.startsWith("- ")) return <li key={i}>{line.slice(2)}</li>;
        if (line.trim() === "") return <div key={i} style={{ height: 8 }} />;
        return <p key={i}>{line}</p>;
      })}
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
  controlEnabled,
  onNavigate,
  onOpenBrowserSettings,
}: {
  platform: "desktop" | "web";
  url: string;
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
            createElement("webview", {
              src: url,
              style: { width: "100%", height: "100%" },
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

/* Browser control: a minimal client-side automation surface over the active webview.
 * Exposed on window.deyinBrowser so agent tooling (and the console) can drive the tab
 * when the Browser control setting is enabled. */

interface ControlledWebview extends HTMLElement {
  loadURL?(url: string): Promise<void>;
  executeJavaScript?(code: string): Promise<unknown>;
  capturePage?(): Promise<{ toDataURL(): string }>;
  getURL?(): string;
}

let activeWebview: ControlledWebview | null = null;

function registerControlledWebview(el: unknown): void {
  activeWebview = (el as ControlledWebview) ?? null;
  publishBrowserControl();
}

function publishBrowserControl(): void {
  const w = window as unknown as { deyinBrowser?: unknown; deyin?: { settings: { get(): Promise<{ browserControlEnabled: boolean }> } } };
  w.deyinBrowser = {
    async navigate(target: string): Promise<void> {
      await assertControlEnabled();
      if (!activeWebview?.loadURL) throw new Error("No controllable browser tab.");
      await activeWebview.loadURL(target);
    },
    async execute(code: string): Promise<unknown> {
      await assertControlEnabled();
      if (!activeWebview?.executeJavaScript) throw new Error("No controllable browser tab.");
      return activeWebview.executeJavaScript(code);
    },
    async screenshot(): Promise<string> {
      await assertControlEnabled();
      if (!activeWebview?.capturePage) throw new Error("No controllable browser tab.");
      const image = await activeWebview.capturePage();
      return image.toDataURL();
    },
    currentUrl(): string | null {
      return activeWebview?.getURL?.() ?? null;
    },
  };
}

async function assertControlEnabled(): Promise<void> {
  const settings = await window.deyin.settings.get();
  if (!settings.browserControlEnabled) {
    throw new Error("Browser control is disabled. Enable it in Settings → Browser.");
  }
}
