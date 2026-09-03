/**
 * Inline embed directives an agent reply can carry: `::deyin-inline-vis{...}`
 * for HTML visualizations, `::deyin-inline-image{...}` for generated images,
 * and `::deyin-inline-video{...}` for generated videos.
 * Parsing lives here (not in Markdown.tsx) so it stays testable without React.
 */

export type MarkdownSegment =
  | { kind: "md"; text: string }
  | { kind: "vis"; file: string; title?: string }
  | { kind: "image"; file: string; alt?: string }
  | { kind: "video"; file: string; title?: string };

const INLINE_EMBED_RE = /::deyin-inline-(vis|image|video)\{([^}]+)\}/g;

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
    if (file) {
      if (m[1] === "image") parts.push({ kind: "image", file, alt });
      else if (m[1] === "video") parts.push({ kind: "video", file, title: title ?? alt });
      else parts.push({ kind: "vis", file, title });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "md", text: text.slice(last) });
  return parts.length > 0 ? parts : [{ kind: "md", text }];
}
