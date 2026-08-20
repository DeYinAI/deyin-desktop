/**
 * Inline embed directives an agent reply can carry: `::deyin-inline-vis{...}`
 * for HTML visualizations and `::deyin-inline-image{...}` for generated images.
 * Parsing lives here (not in Markdown.tsx) so it stays testable without React.
 */

export type MarkdownSegment =
  | { kind: "md"; text: string }
  | { kind: "vis"; file: string; title?: string }
  | { kind: "image"; file: string; alt?: string };

const INLINE_EMBED_RE = /::deyin-inline-(vis|image)\{([^}]+)\}/g;

function parseAttrs(attrs: string): { file?: string; title?: string; alt?: string } {
  return {
    file: /file="([^"]+)"/.exec(attrs)?.[1],
    title: /title="([^"]+)"/.exec(attrs)?.[1],
    alt: /alt="([^"]+)"/.exec(attrs)?.[1],
  };
}

/** Split markdown into text segments and inline visualization/image directives. */
export function splitInlineEmbeds(text: string): MarkdownSegment[] {
  const parts: MarkdownSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(INLINE_EMBED_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: "md", text: text.slice(last, m.index) });
    const { file, title, alt } = parseAttrs(m[2] ?? "");
    if (file) parts.push(m[1] === "image" ? { kind: "image", file, alt } : { kind: "vis", file, title });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "md", text: text.slice(last) });
  return parts.length > 0 ? parts : [{ kind: "md", text }];
}
