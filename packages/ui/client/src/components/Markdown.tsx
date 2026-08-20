import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, type CodeTheme } from "../code.js";
import { splitInlineEmbeds } from "../embeds.js";
import type { ChatCodeDisplay } from "./ChatView.js";
import { InlineImage } from "./InlineImage.js";
import { InlineVisualization } from "./InlineVisualization.js";

interface MarkdownProps {
  text: string;
  theme: CodeTheme;
  display: ChatCodeDisplay;
  threadId?: string | null;
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
export function Markdown({ text, theme, display, threadId }: MarkdownProps) {
  const segments = splitInlineEmbeds(text);
  return (
    <div className="markdown">
      {segments.map((seg, i) =>
        seg.kind === "vis" && threadId ? (
          <InlineVisualization key={`vis-${i}`} threadId={threadId} file={seg.file} title={seg.title} />
        ) : seg.kind === "image" && threadId ? (
          <InlineImage key={`img-${i}`} threadId={threadId} file={seg.file} alt={seg.alt} />
        ) : seg.kind === "md" && seg.text.trim() ? (
          <MarkdownBlock key={`md-${i}`} text={seg.text} theme={theme} display={display} />
        ) : null,
      )}
    </div>
  );
}

function MarkdownBlock({ text, theme, display }: MarkdownProps) {
  return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            const { code, lang } = codeChild(children);
            return (
              <CodeBlock
                code={code}
                lang={lang || undefined}
                theme={theme}
                fontSize={display.fontSize}
                showLineNumbers={display.showLineNumbers}
                wrapLongLines={display.wrapLongLines}
              />
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
