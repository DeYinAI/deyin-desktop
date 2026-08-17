/**
 * Dependency-free code rendering: a small tokenizer plus real theme palettes so
 * the Appearance code-theme settings drive actual colors in chat code blocks
 * and the settings preview. Deliberately approximate — good highlighting for
 * the common languages without shipping a highlighting engine.
 */

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

export interface CodeBlockProps {
  code: string;
  theme: CodeTheme;
  fontSize: number;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  /** Fence language tag, shown in the block header when present. */
  lang?: string;
}

export function CodeBlock(props: CodeBlockProps) {
  const lines = props.code.replace(/\n$/, "").split("\n");
  return (
    <div className="codeblock" style={{ background: props.theme.bg, color: props.theme.fg }}>
      {props.lang && <div className="codeblock__lang">{props.lang}</div>}
      <pre
        className="codeblock__pre"
        style={{
          fontSize: props.fontSize,
          whiteSpace: props.wrapLongLines ? "pre-wrap" : "pre",
          overflowX: props.wrapLongLines ? "hidden" : "auto",
        }}
      >
        {lines.map((line, i) => (
          <span className="codeblock__line" key={i}>
            {props.showLineNumbers && <span className="codeblock__no">{i + 1}</span>}
            <span className="codeblock__text">
              {tokenize(line).map((token, j) =>
                token.type === "plain" ? (
                  token.text
                ) : (
                  <span key={j} style={{ color: props.theme.colors[token.type] }}>
                    {token.text}
                  </span>
                ),
              )}
              {"\n"}
            </span>
          </span>
        ))}
      </pre>
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
