import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { fetchImageAsBase64, generateImages, modelImageCapability, type ImageCapability } from "../images.js";
import { ImageStore } from "./image-store.js";

/** One image model the signed-in catalog offers, with how it must be called. */
export interface ImageModelChoice {
  id: string;
  /** "endpoint" → /images/generations, "chat" → a chat model that draws. */
  route: ImageCapability;
}

export interface ImageBridgeDeps {
  store: ImageStore;
  threadId: string;
  apiBaseUrl: string;
  getToken: () => Promise<string | null>;
  /** Image-capable models from the catalog, best first. */
  models: () => ImageModelChoice[];
  /** Workspace root, for `save_to` and workspace-relative input images. */
  cwd?: string;
  signal?: AbortSignal;
}

/** One stored result, in the shape agent-core's ImageGenBridge expects. */
export interface StoredImageRef {
  file: string;
  model?: string;
  mediaType: string;
  path?: string;
  savedTo?: string;
}

export interface ImageBridgeRequest {
  prompt: string;
  model?: string;
  size?: string;
  n?: number;
  negativePrompt?: string;
  inputImages?: string[];
  saveTo?: string;
}

const MEDIA_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Message shown when the plan has no image model at all. */
const NO_MODEL =
  "No image model is available on this provider. Pick one under Settings → Models (a text-to-image model such as FLUX or gpt-image, or a chat model that draws such as Gemini flash-image), or pass an explicit model id.";

/**
 * Choose which model draws. An explicit id always wins — its route is looked up
 * in the catalog and falls back to id classification for models the catalog did
 * not describe. Editing prefers a chat model that draws, because those keep the
 * source picture faithfully; fresh generation prefers a dedicated text-to-image
 * model, which is what the images endpoint is best at.
 */
export function pickImageModel(
  models: ImageModelChoice[],
  opts: { requested?: string; editing?: boolean },
): ImageModelChoice | undefined {
  if (opts.requested) {
    const known = models.find((m) => m.id === opts.requested);
    if (known) return known;
    const capability = modelImageCapability(opts.requested);
    return { id: opts.requested, route: capability === "none" ? "endpoint" : capability };
  }
  const preferred = opts.editing ? "chat" : "endpoint";
  return models.find((m) => m.route === preferred) ?? models[0];
}

/**
 * Host side of image generation: model selection, the provider call, storing the
 * result with the thread, optional workspace copies, and persisting pictures a
 * chat model drew inside its own completion.
 *
 * Shared by the desktop and web hosts so both cover the same scenarios: fresh
 * generation, editing an earlier image or a workspace file, saving into the
 * project, and inline image output from a chat model.
 */
export function createImageBridge(deps: ImageBridgeDeps) {
  const readInput = (reference: string): { base64: string; mediaType: string } => {
    // A file name from an earlier generation lives in the thread's image store.
    if (!reference.includes("/") && !reference.includes("\\")) {
      const stored = deps.store.read(deps.threadId, reference);
      return { base64: stored.base64, mediaType: stored.mediaType };
    }
    if (!deps.cwd) throw new Error(`Cannot read ${reference}: this host has no workspace.`);
    const path = isAbsolute(reference) ? resolve(reference) : resolve(deps.cwd, reference);
    const root = resolve(deps.cwd);
    if (path !== root && !path.startsWith(root + sep)) throw new Error(`${reference} is outside the workspace.`);
    if (!existsSync(path)) throw new Error(`Input image not found: ${reference}`);
    const mediaType = MEDIA_BY_EXT[extname(path).toLowerCase()];
    if (!mediaType) throw new Error(`${reference} is not a supported image (png, jpg, webp, gif).`);
    return { base64: readFileSync(path).toString("base64"), mediaType };
  };

  const writeWorkspaceCopy = (target: string, base64: string): string => {
    if (!deps.cwd) throw new Error("This host has no workspace to save into.");
    const path = isAbsolute(target) ? resolve(target) : resolve(deps.cwd, target);
    const root = resolve(deps.cwd);
    if (path !== root && !path.startsWith(root + sep)) throw new Error(`${target} is outside the workspace.`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(base64, "base64"));
    return path;
  };

  return {
    async generate(request: ImageBridgeRequest): Promise<StoredImageRef[]> {
      const editing = (request.inputImages?.length ?? 0) > 0;
      const chosen = pickImageModel(deps.models(), { requested: request.model, editing });
      if (!chosen) throw new Error(NO_MODEL);
      const token = await deps.getToken();
      if (token === null) throw new Error("Signed out — sign in to generate images.");

      const inputImages = (request.inputImages ?? []).map(readInput);
      const generated = await generateImages({
        apiBaseUrl: deps.apiBaseUrl,
        token,
        model: chosen.id,
        route: chosen.route,
        prompt: request.prompt,
        size: request.size ?? "1024x1024",
        n: request.n ?? 1,
        ...(inputImages.length > 0 ? { inputImages } : {}),
        ...(request.negativePrompt ? { extra: { negative_prompt: request.negativePrompt } } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      });

      return generated.map((image, index) => {
        const saved = deps.store.save(deps.threadId, { base64: image.base64, mediaType: image.mediaType });
        // Only the first picture takes the requested path; extras would overwrite it.
        const savedTo = request.saveTo && index === 0 ? writeWorkspaceCopy(request.saveTo, image.base64) : undefined;
        return {
          file: saved.file,
          model: chosen.id,
          mediaType: saved.mediaType,
          path: saved.path,
          ...(savedTo ? { savedTo } : {}),
        };
      });
    },

    /** Persist a picture a chat model produced inside its completion. */
    async save(image: { base64?: string; url?: string; mediaType?: string }): Promise<StoredImageRef> {
      let base64 = image.base64;
      let mediaType = image.mediaType ?? "image/png";
      if (!base64 && image.url) {
        const fetched = await fetchImageAsBase64(image.url, deps.signal);
        if (!fetched) throw new Error(`Could not download the generated image (${image.url.slice(0, 80)}).`);
        base64 = fetched.base64;
        mediaType = fetched.mediaType;
      }
      if (!base64) throw new Error("Generated image carried no data.");
      const saved = deps.store.save(deps.threadId, { base64, mediaType });
      return { file: saved.file, mediaType: saved.mediaType, path: saved.path };
    },
  };
}

/**
 * Store the pictures a user attached to their message so the agent can edit them
 * by file name, and return the note that tells the model those names. Attached
 * images otherwise live only in the vision content parts, where no tool can
 * reach them — "make this darker" would have nothing to work from.
 */
export function storeAttachedImages(
  store: ImageStore,
  threadId: string,
  images: { base64: string; mediaType: string }[],
): { files: string[]; note: string } {
  const files: string[] = [];
  for (const image of images) {
    try {
      files.push(store.save(threadId, { base64: image.base64, mediaType: image.mediaType }).file);
    } catch {
      // A picture too large for the store simply stays vision-only.
    }
  }
  const note =
    files.length > 0
      ? `\n\n[The attached image${files.length > 1 ? "s are" : " is"} stored as ${files.join(", ")}. To change ${files.length > 1 ? "them" : "it"}, call generate_image with input_images set to ${files.length > 1 ? "those names" : "that name"}.]`
      : "";
  return { files, note };
}
