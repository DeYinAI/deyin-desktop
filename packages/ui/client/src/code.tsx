/**
 * Dependency-free code rendering: a small tokenizer plus real theme palettes so
 * the Appearance code-theme settings drive actual colors in chat code blocks
 * and the settings preview. Deliberately approximate — good highlighting for
 * the common languages without shipping a highlighting engine.
 */

import { useCallback, useRef, useState, type CSSProperties } from "react";
import { Icon } from "./components/Icon.js";
import { useT } from "./i18n.js";

export type TokenType = "kw" | "str" | "num" | "com" | "fn" | "type" | "plain";

export interface CodeTheme {
  name: string;
  variant: "light" | "dark";
  bg: string;
  fg: string;
  colors: Record<Exclude<TokenType, "plain">, string>;
}

export const CODE_THEMES: CodeTheme[] = [
  {
    name: "GitHub Light",
    variant: "light",
    bg: "#ffffff",
    fg: "#1f2328",
    colors: { kw: "#cf222e", str: "#0a3069", num: "#0550ae", com: "#59636e", fn: "#8250df", type: "#953800" },
  },
  {
    name: "One Light",
    variant: "light",
    bg: "#fafafa",
    fg: "#383a42",
    colors: { kw: "#a626a4", str: "#50a14f", num: "#986801", com: "#a0a1a7", fn: "#4078f2", type: "#c18401" },
  },
  {
    name: "Solarized Light",
    variant: "light",
    bg: "#fdf6e3",
    fg: "#657b83",
    colors: { kw: "#859900", str: "#2aa198", num: "#d33682", com: "#93a1a1", fn: "#268bd2", type: "#b58900" },
  },
  {
    name: "GitHub Dark",
    variant: "dark",
    bg: "#0d1117",
    fg: "#e6edf3",
    colors: { kw: "#ff7b72", str: "#a5d6ff", num: "#79c0ff", com: "#8b949e", fn: "#d2a8ff", type: "#ffa657" },
  },
  {
    name: "One Dark",
    variant: "dark",
    bg: "#282c34",
    fg: "#abb2bf",
    colors: { kw: "#c678dd", str: "#98c379", num: "#d19a66", com: "#5c6370", fn: "#61afef", type: "#e5c07b" },
  },
  {
    name: "Midnight",
    variant: "dark",
    bg: "#05070a",
    fg: "#c9d4e3",
    colors: { kw: "#7aa2f7", str: "#9ece6a", num: "#ff9e64", com: "#565f89", fn: "#bb9af7", type: "#2ac3de" },
  },
];

export const LIGHT_CODE_THEMES = CODE_THEMES.filter((t) => t.variant === "light").map((t) => t.name);
export const DARK_CODE_THEMES = CODE_THEMES.filter((t) => t.variant === "dark").map((t) => t.name);

export function themeByName(name: string, variant: "light" | "dark"): CodeTheme {
  return (
    CODE_THEMES.find((t) => t.name === name && t.variant === variant) ??
    CODE_THEMES.find((t) => t.variant === variant)!
  );
}

/* Tokenizer ------------------------------------------------------------------ */

const KEYWORDS = new Set(
  (
    "const let var function return if else for while do switch case break continue new class extends super this " +
    "import export from default async await try catch finally throw typeof instanceof in of delete void yield " +
    "interface type enum implements public private protected readonly static namespace declare as is keyof infer " +
    "def elif lambda pass raise with global nonlocal assert not and or None True False print self " +
    "fn mut impl trait struct match loop pub use mod crate where dyn ref move unsafe " +
    "package func go chan defer select map range nil " +
    "echo fi then esac done local exit sudo cd ls null true false undefined"
  ).split(/\s+/),
);

export interface Token {
  type: TokenType;
  text: string;
}

const TOKEN_RE =
  /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+|[^\sA-Za-z_$"'`\d]+)/g;

/** Tokenize one line-or-more of code into colored spans. */
export function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(code)) !== null) {
    const [, comment, str, num, word, rest] = match;
    if (comment !== undefined) tokens.push({ type: "com", text: comment });
    else if (str !== undefined) tokens.push({ type: "str", text: str });
    else if (num !== undefined) tokens.push({ type: "num", text: num });
    else if (word !== undefined) {
      if (KEYWORDS.has(word)) tokens.push({ type: "kw", text: word });
      else if (/^[A-Z]/.test(word)) tokens.push({ type: "type", text: word });
      else {
        // Peek: identifiers directly followed by "(" render as calls.
        const next = code.slice(TOKEN_RE.lastIndex, TOKEN_RE.lastIndex + 1);
        tokens.push({ type: next === "(" ? "fn" : "plain", text: word });
      }
    } else if (rest !== undefined) tokens.push({ type: "plain", text: rest });
  }
  return tokens;
}

/* Components ------------------------------------------------------------------ */

const COLLAPSE_THRESHOLD = 16;
const COLLAPSED_LINES = 12;
/** Expanded blocks scroll inside the chat instead of stretching the whole thread. */
const EXPANDED_MAX_HEIGHT = "min(70vh, 560px)";

export interface CodeBlockProps {
  code: string;
  theme: CodeTheme;
  fontSize: number;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  /** Fence language tag, shown in the block header when present. */
  lang?: string;
  /** Allow long blocks in chat to collapse behind a "Show all" control. */
  collapsible?: boolean;
  /** Start collapsed when collapsible (e.g. HTML source under a live preview). */
  defaultCollapsed?: boolean;
}

function renderLines(
  lines: string[],
  theme: CodeTheme,
  showLineNumbers: boolean,
  startIndex = 0,
) {
  return lines.map((line, i) => (
    <span className="codeblock__line" key={startIndex + i}>
      {showLineNumbers && <span className="codeblock__no">{startIndex + i + 1}</span>}
      <span className="codeblock__text">
        {tokenize(line).map((token, j) =>
          token.type === "plain" ? (
            token.text
          ) : (
            <span key={j} style={{ color: theme.colors[token.type] }}>
              {token.text}
            </span>
          ),
        )}
        {"\n"}
      </span>
    </span>
  ));
}

export function CodeBlock(props: CodeBlockProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(() => {
    if (!(props.collapsible ?? false)) return true;
    if (props.defaultCollapsed) return false;
    const lineCount = props.code.replace(/\n$/, "").split("\n").length;
    return lineCount <= COLLAPSE_THRESHOLD;
  });
  const rootRef = useRef<HTMLDivElement>(null);

  const lines = props.code.replace(/\n$/, "").split("\n");
  const canCollapse = (props.collapsible ?? false) && lines.length > COLLAPSE_THRESHOLD;
  const collapsed = canCollapse && !expanded;
  const visibleLines = collapsed ? lines.slice(0, COLLAPSED_LINES) : lines;
  const langLabel = props.lang?.trim() || "text";

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(props.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }, [props.code]);

  const expand = useCallback(() => {
    setExpanded(true);
    requestAnimationFrame(() => {
      rootRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }, []);

  return (
    <div
      ref={rootRef}
      className={`codeblock${collapsed ? " codeblock--collapsed" : ""}${expanded && canCollapse ? " codeblock--expanded" : ""}`}
      style={
        {
          background: props.theme.bg,
          color: props.theme.fg,
          "--codeblock-bg": props.theme.bg,
        } as CSSProperties
      }
    >
      <div className="codeblock__header">
        <span className="codeblock__lang">{langLabel}</span>
        <div className="codeblock__actions">
          {canCollapse && (
            <button
              type="button"
              className="codeblock__btn"
              onClick={() => {
                if (expanded) setExpanded(false);
                else expand();
              }}
              aria-expanded={expanded}
              title={expanded ? t("chat.collapseCode") : t("chat.showAllCode")}
            >
              <Icon name={expanded ? "minimize" : "maximize"} size={13} />
              <span>{expanded ? t("chat.collapseCode") : t("chat.showAllCode")}</span>
            </button>
          )}
          <button
            type="button"
            className="codeblock__btn"
            onClick={copy}
            aria-label={copied ? t("chat.copied") : t("chat.copyCode")}
            title={copied ? t("chat.copied") : t("chat.copyCode")}
          >
            <Icon name={copied ? "check" : "copy"} size={13} />
            <span>{copied ? t("chat.copied") : t("chat.copyCode")}</span>
          </button>
        </div>
      </div>
      <div
        className="codeblock__body"
        style={expanded && canCollapse ? { maxHeight: EXPANDED_MAX_HEIGHT } : undefined}
      >
        <pre
          className="codeblock__pre"
          style={{
            fontSize: props.fontSize,
            whiteSpace: props.wrapLongLines ? "pre-wrap" : "pre",
            overflowX: props.wrapLongLines ? "hidden" : "auto",
          }}
        >
          {renderLines(visibleLines, props.theme, props.showLineNumbers)}
        </pre>
        {collapsed && (
          <button
            type="button"
            className="codeblock__expand"
            onClick={expand}
            aria-expanded={false}
          >
            {t("chat.showAllCode")} ({lines.length} {t("chat.codeLines")})
          </button>
        )}
      </div>
    </div>
  );
}

/* Markdown-ish splitting -------------------------------------------------------- */

export type MessageSegment = { type: "text"; text: string } | { type: "code"; lang: string; code: string };

/** Split assistant text on ``` fences so code renders through CodeBlock. */
export function splitMessageSegments(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    if (match.index > last) segments.push({ type: "text", text: text.slice(last, match.index) });
    segments.push({ type: "code", lang: (match[1] ?? "").trim(), code: match[2] ?? "" });
    last = fence.lastIndex;
  }
  if (last < text.length) segments.push({ type: "text", text: text.slice(last) });
  return segments.length > 0 ? segments : [{ type: "text", text }];
}
