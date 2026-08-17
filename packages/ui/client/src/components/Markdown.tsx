import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, type CodeTheme } from "../code.js";
import type { ChatCodeDisplay } from "./ChatView.js";
import { InlineVisualization } from "./InlineVisualization.js";

interface MarkdownProps {
  text: string;
  theme: CodeTheme;
  display: ChatCodeDisplay;
  threadId?: string | null;
}

const INLINE_VIS_RE = /::deyin-inline-vis\{([^}]+)\}/g;

function parseVisAttrs(attrs: string): { file?: string; title?: string } {
  return {
    file: /file="([^"]+)"/.exec(attrs)?.[1],
    title: /title="([^"]+)"/.exec(attrs)?.[1],
  };
}

/** Split markdown into text segments and inline visualization directives. */
function splitInlineVis(text: string): Array<{ kind: "md"; text: string } | { kind: "vis"; file: string; title?: string }> {
  const parts: Array<{ kind: "md"; text: string } | { kind: "vis"; file: string; title?: string }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(INLINE_VIS_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: "md", text: text.slice(last, m.index) });
    const { file, title } = parseVisAttrs(m[1] ?? "");
    if (file) parts.push({ kind: "vis", file, title });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "md", text: text.slice(last) });
  return parts.length > 0 ? parts : [{ kind: "md", text }];
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
  const segments = splitInlineVis(text);
  return (
    <div className="markdown">
      {segments.map((seg, i) =>
        seg.kind === "vis" && threadId ? (
          <InlineVisualization key={`vis-${i}`} threadId={threadId} file={seg.file} title={seg.title} />
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
