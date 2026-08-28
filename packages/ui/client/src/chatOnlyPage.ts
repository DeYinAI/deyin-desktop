import { extractHtmlPageFromMarkdownLoose, titleFromHtml } from "./htmlPage.js";

export interface ChatOnlyPageArtifact {
  fileName: string;
  title: string;
  preview: string;
}

function previewFromHtml(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 220);
}

/** Persist a full HTML page from assistant markdown (chat-only web, IndexedDB). */
export async function persistChatOnlyPageFromMarkdown(
  threadId: string,
  markdown: string,
): Promise<ChatOnlyPageArtifact | null> {
  const html = extractHtmlPageFromMarkdownLoose(markdown);
  if (!html || !window.deyin.page.save) return null;
  const title = titleFromHtml(html) ?? "Page preview";
  const saved = await window.deyin.page.save(threadId, { html, title });
  return { fileName: saved.file, title, preview: previewFromHtml(html) };
}
