import type { ToolDefinition } from "../types.js";
import { asOptionalString, asString } from "./util.js";

/** Escape a value for embedding in a ::deyin-inline-image{...} attribute. */
function escapeDirectiveAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "'").replace(/[\r\n]+/g, " ").trim();
}

/** The chat directive that renders a stored image inline in the reply. */
export function inlineImageDirective(file: string, alt?: string): string {
  const altAttr = alt ? ` alt="${escapeDirectiveAttr(alt)}"` : "";
  return `::deyin-inline-image{file="${escapeDirectiveAttr(file)}"${altAttr}}`;
}

const MAX_IMAGES = 4;
const MAX_INPUT_IMAGES = 4;

/** String array argument, tolerating a single string or a JSON-encoded list. */
function asStringList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
      } catch {
        // Not JSON — treat it as one path.
      }
    }
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

export const generateImageTool: ToolDefinition = {
  name: "generate_image",
  description:
    "Generate or edit an image with an image model (SDXL, FLUX, DALL·E, gpt-image, Gemini flash-image). Pass input_images to edit a picture the thread already has instead of drawing a new one. Returns an embed directive; put it in your reply on its own line so the picture renders in the chat. Use for illustrations, mockups, icons, concept art and photo-style scenes the user asks to see.",
  tier: "write",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Full description of the image: subject, composition, style, lighting, colors. Write it out — the image model has no access to the conversation. When editing, describe the change and what must stay the same.",
      },
      model: {
        type: "string",
        description: "Image model id. Omit to use the workspace default image model.",
      },
      size: { type: "string", description: 'Pixel size, e.g. "1024x1024", "1152x896". Defaults to 1024x1024.' },
      n: { type: "number", description: `How many images to generate (1-${MAX_IMAGES}, default 1).` },
      negative_prompt: { type: "string", description: "What to keep out of the image, when the model supports it." },
      input_images: {
        type: "array",
        items: { type: "string" },
        description: `Pictures to edit or use as reference (max ${MAX_INPUT_IMAGES}): file names from an earlier generate_image result, or workspace-relative image paths.`,
      },
      save_to: {
        type: "string",
        description:
          "Workspace-relative path to also write the image to (e.g. \"assets/hero.png\"). Use when the picture belongs to the project — a README image, an icon, a test fixture — not just the chat.",
      },
      alt: { type: "string", description: "Short alt text for the rendered image (accessibility)." },
    },
    required: ["prompt"],
  },
  summarize: (args) => {
    const editing = asStringList(args.input_images).length > 0;
    return `${editing ? "edit image" : "image"}: ${String(args.prompt ?? "").slice(0, 60)}`;
  },
  async execute(args, ctx): Promise<string> {
    const bridge = ctx.imageGen;
    if (!bridge) return "ERROR: image generation is not available in this host.";
    const prompt = asString(args.prompt, "prompt").trim();
    if (!prompt) return "ERROR: prompt is required.";
    const requested = typeof args.n === "number" && Number.isFinite(args.n) ? Math.floor(args.n) : 1;
    const n = Math.min(Math.max(requested, 1), MAX_IMAGES);
    const inputImages = asStringList(args.input_images).slice(0, MAX_INPUT_IMAGES);

    try {
      const images = await bridge.generate({
        prompt,
        model: asOptionalString(args.model),
        size: asOptionalString(args.size),
        negativePrompt: asOptionalString(args.negative_prompt),
        n,
        ...(inputImages.length > 0 ? { inputImages } : {}),
        ...(asOptionalString(args.save_to) ? { saveTo: asOptionalString(args.save_to) } : {}),
      });
      if (images.length === 0) return "ERROR: the image model returned no image.";
      const alt = asOptionalString(args.alt) ?? prompt.slice(0, 120);
      const lines = images.map((img) => inlineImageDirective(img.file, alt));
      const model = images[0]?.model ? ` with ${images[0].model}` : "";
      const verb = inputImages.length > 0 ? "Edited" : "Generated";
      const saved = images.map((img) => img.savedTo).filter((p): p is string => Boolean(p));
      return [
        `${verb} ${images.length} image${images.length > 1 ? "s" : ""}${model}.`,
        ...(saved.length > 0 ? [`Written to the workspace: ${saved.join(", ")}.`] : []),
        "Embed in your reply, each directive on its own line:",
        ...lines,
      ].join("\n");
    } catch (err) {
      return `ERROR generating image: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
