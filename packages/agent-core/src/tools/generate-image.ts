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

export const generateImageTool: ToolDefinition = {
  name: "generate_image",
  description:
    "Generate an image from a text prompt with a text-to-image model (SDXL, FLUX, DALL·E...). Returns an embed directive; put it in your reply on its own line so the picture renders in the chat. Use for illustrations, mockups, icons, concept art and diagrams the user asks to see.",
  tier: "write",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Full description of the image: subject, composition, style, lighting, colors. Write it out — the image model has no access to the conversation.",
      },
      model: {
        type: "string",
        description: "Text-to-image model id. Omit to use the workspace default image model.",
      },
      size: { type: "string", description: 'Pixel size, e.g. "1024x1024", "1152x896". Defaults to 1024x1024.' },
      n: { type: "number", description: `How many images to generate (1-${MAX_IMAGES}, default 1).` },
      negative_prompt: { type: "string", description: "What to keep out of the image, when the model supports it." },
      alt: { type: "string", description: "Short alt text for the rendered image (accessibility)." },
    },
    required: ["prompt"],
  },
  summarize: (args) => `image: ${String(args.prompt ?? "").slice(0, 60)}`,
  async execute(args, ctx): Promise<string> {
    const bridge = ctx.imageGen;
    if (!bridge) return "ERROR: image generation is not available in this host.";
    const prompt = asString(args.prompt, "prompt").trim();
    if (!prompt) return "ERROR: prompt is required.";
    const requested = typeof args.n === "number" && Number.isFinite(args.n) ? Math.floor(args.n) : 1;
    const n = Math.min(Math.max(requested, 1), MAX_IMAGES);

    try {
      const images = await bridge.generate({
        prompt,
        model: asOptionalString(args.model),
        size: asOptionalString(args.size),
        negativePrompt: asOptionalString(args.negative_prompt),
        n,
      });
      if (images.length === 0) return "ERROR: the image model returned no image.";
      const alt = asOptionalString(args.alt) ?? prompt.slice(0, 120);
      const lines = images.map((img) => inlineImageDirective(img.file, alt));
      const model = images[0]?.model ? ` with ${images[0].model}` : "";
      return [
        `Generated ${images.length} image${images.length > 1 ? "s" : ""}${model}.`,
        "Embed in your reply, each directive on its own line:",
        ...lines,
      ].join("\n");
    } catch (err) {
      return `ERROR generating image: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
