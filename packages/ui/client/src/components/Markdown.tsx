import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, type CodeTheme } from "../code.js";
import { isFullHtmlDocument } from "../htmlPage.js";
import { splitInlineEmbeds } from "../embeds.js";
import { looksLikeFilePath, resolveWorkspaceFilePath } from "../filePath.js";
import type { ChatCodeDisplay } from "./ChatView.js";
import { InlineImage } from "./InlineImage.js";
import { InlineVideo } from "./InlineVideo.js";
import { InlineVisualization } from "./InlineVisualization.js";

interface MarkdownProps {
  text: string;
  theme: CodeTheme;
  display: ChatCodeDisplay;
  threadId?: string | null;
  workspaceRoot?: string | null;
  /** Open a workspace file in the right-hand Files panel. */
  onOpenWorkspaceFile?: (path: string) => void;
}

/** Extract the raw code text and fence language from a <pre>'s <code> child. */
function codeChild(children: ReactNode): { code: string; lang: string } {
  try {
    const child = Children.only(children);
    if (isValidElement(child)) {
      const el = child as ReactElement<{ className?: string; children?: ReactNode }>;
      const lang = /language-([\w+-]+)/.exec(el.props.className ?? "")?.[1] ?? "";
      return { code: flattenText(el.props.children), lang };
    }
  } catch {
    // Multiple/unexpected children: fall through to flattening everything.
  }
  return { code: flattenText(children), lang: "" };
}

function flattenText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement(node)) return flattenText((node.props as { children?: ReactNode }).children);
  return "";
}

/**
 * Assistant markdown: GFM (tables, task lists, strikethrough) with code fences
 * rendered through the themed CodeBlock so Appearance settings keep applying.
 */
export function Markdown({
  text,
  theme,
  display,
  threadId,
  workspaceRoot,
  onOpenWorkspaceFile,
}: MarkdownProps) {
  const segments = splitInlineEmbeds(text);
  return (
    <div className="markdown">
      {segments.map((seg, i) =>
        seg.kind === "vis" && threadId ? (
          <InlineVisualization key={`vis-${i}`} threadId={threadId} file={seg.file} title={seg.title} />
        ) : seg.kind === "image" && threadId ? (
          <InlineImage key={`img-${i}`} threadId={threadId} file={seg.file} alt={seg.alt} />
        ) : seg.kind === "video" && threadId ? (
          <InlineVideo key={`vid-${i}`} threadId={threadId} file={seg.file} title={seg.title} />
        ) : seg.kind === "md" && seg.text.trim() ? (
          <MarkdownBlock
            key={`md-${i}`}
            text={seg.text}
            theme={theme}
            display={display}
            workspaceRoot={workspaceRoot}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
          />
        ) : null,
      )}
    </div>
  );
}

function MarkdownBlock({ text, theme, display, workspaceRoot, onOpenWorkspaceFile }: MarkdownProps) {
  return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            const { code, lang } = codeChild(children);
            const langNorm = lang.toLowerCase();
            const fullPage = isFullHtmlDocument(code);
            return (
              <CodeBlock
                code={code}
                lang={lang || undefined}
                theme={theme}
                fontSize={display.fontSize}
                showLineNumbers={display.showLineNumbers}
                wrapLongLines={display.wrapLongLines}
                collapsible
                defaultCollapsed={fullPage && (langNorm === "html" || langNorm === "htm" || langNorm === "")}
              />
            );
          },
          code({ className, children, ...rest }) {
            const isBlock = /language-/.test(className ?? "");
            if (isBlock) return <code className={className} {...rest}>{children}</code>;
            const label = flattenText(children);
            if (onOpenWorkspaceFile && looksLikeFilePath(label)) {
              const target = resolveWorkspaceFilePath(workspaceRoot ?? null, label);
              return (
                <button
                  type="button"
                  className="md-file-link"
                  onClick={() => onOpenWorkspaceFile(target)}
                >
                  {label}
                </button>
              );
            }
            return <code className="ui-code-tag" {...rest}>{children}</code>;
          },
          blockquote({ children }) {
            return <div className="ui-callout markdown-callout">{children}</div>;
          },
          h1({ children }) {
            return <h1 className="md-section-heading md-section-heading--title">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="md-section-heading">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="md-section-heading md-section-heading--sub">{children}</h3>;
          },
          img({ src, alt }) {
            if (!src) return null;
            return <img src={src} alt={alt ?? ""} className="md-image" loading="lazy" />;
          },
          table({ children }) {
            return (
              <div className="md-table-wrap">
                <table className="ui-data-table md-data-table">{children}</table>
              </div>
            );
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                onClick={(e) => {
                  // Never navigate the app window; route through the host shell.
                  e.preventDefault();
                  if (href) window.deyin.shell.openExternal(href);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
  );
}
