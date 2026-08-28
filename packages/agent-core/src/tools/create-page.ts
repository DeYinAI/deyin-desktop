import type { PageArtifact, ToolDefinition } from "../types.js";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function pagePreviewFromHtml(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "Interactive page ready in the Preview panel.";
  return text.length > 220 ? `${text.slice(0, 217)}…` : text;
}

export const createPageTool: ToolDefinition = {
  name: "create_page",
  description:
    "Create a one-page website artifact and open it in the Preview panel. Use when the user asks for a landing page, portfolio page, microsite, or any self-contained HTML page. Provide complete HTML (full document or body content with inline CSS). Do not use for repo files the user will edit — use write for those.",
  tier: "write",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short page title shown in chat and the Preview tab." },
      html: { type: "string", description: "Full HTML document or body fragment (styles/scripts inline)." },
      file: { type: "string", description: "Optional file name, e.g. landing.html" },
    },
    required: ["title", "html"],
  },
  summarize: (args) => `page ${String(args.title ?? args.file ?? "website")}`,
  async execute(args, ctx): Promise<string> {
    const bridge = ctx.pageArtifact;
    if (!bridge) return "ERROR: create_page is not available in this host.";

    const threadId = ctx.sessionMeta?.threadId;
    if (!threadId) return "ERROR: no active thread for page artifact.";

    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Page";
    const html = typeof args.html === "string" ? args.html.trim() : "";
    if (!html) return "ERROR: create_page requires non-empty html.";

    const rawFile = typeof args.file === "string" && args.file.trim() ? args.file.trim() : `${slugify(title) || "page"}.html`;

    try {
      const written = await bridge.write({ threadId, file: rawFile, html, title });
      const artifact: PageArtifact = {
        title,
        fileName: written.fileName,
        filePath: written.filePath,
        html: written.html,
        preview: pagePreviewFromHtml(written.html),
      };
      ctx.onPageCreated?.(artifact);
      return `Page "${title}" saved as ${written.fileName}. It is open in the Preview panel — tell the user they can click the card to reopen it.`;
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
