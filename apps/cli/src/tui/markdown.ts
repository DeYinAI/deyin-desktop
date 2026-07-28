import { bold, cyan, dim, italic, underline } from "../output.js";

/**
 * Minimal markdown -> ANSI renderer for chat output: headings, bullets, fenced code,
 * inline code/bold/italic/links and blockquotes. Deliberately lossy but stable — the
 * raw text is always preserved, only styling is added.
 */
export function renderMarkdown(source: string): string {
  const out: string[] = [];
  let inFence = false;

  for (const line of source.split("\n")) {
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      inFence = !inFence;
      out.push(dim(inFence && fence[1] ? `\`\`\`${fence[1]}` : "```"));
      continue;
    }
    if (inFence) {
      out.push(`  ${cyan(line)}`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const text = inline(heading[2] ?? "");
      out.push(heading[1]!.length === 1 ? bold(underline(text)) : bold(text));
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      out.push(dim(`\u2502 ${inline(line.replace(/^\s*>\s?/, ""))}`));
      continue;
    }
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      out.push(`${bullet[1]}\u2022 ${inline(bullet[2] ?? "")}`);
      continue;
    }
    if (/^\s*([-*_]){3,}\s*$/.test(line)) {
      out.push(dim("\u2500".repeat(30)));
      continue;
    }
    out.push(inline(line));
  }

  return out.join("\n");
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, code: string) => cyan(code))
    .replace(/\*\*([^*]+)\*\*/g, (_, t: string) => bold(t))
    .replace(/(?<![*\w])\*([^*\s][^*]*)\*(?![*\w])/g, (_, t: string) => italic(t))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) => `${label} ${dim(`(${url})`)}`);
}

/** Last N lines of a string (for the live streaming region). */
export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(lines.length - n).join("\n");
}
