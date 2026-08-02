/** Parse ::deyin-inline-vis{file="x.html" title="Y"} directives from markdown. */
export function parseInlineVisDirectives(text: string): Array<{ file: string; title?: string; raw: string }> {
  const re = /::deyin-inline-vis\{([^}]+)\}/g;
  const out: Array<{ file: string; title?: string; raw: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const attrs = m[1] ?? "";
    const file = /file="([^"]+)"/.exec(attrs)?.[1];
    const title = /title="([^"]+)"/.exec(attrs)?.[1];
    if (file) out.push({ file, title, raw: m[0] });
  }
  return out;
}

export function stripInlineVisDirectives(text: string): string {
  return text.replace(/::deyin-inline-vis\{[^}]+\}/g, "").trim();
}
