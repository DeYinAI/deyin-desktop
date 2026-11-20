import { generateImages, modelImageCapability, type GeneratedImage, type ImageStore } from "@deyin/host-core";
import { imageParamsToExtra } from "@deyin/host-core";
import type { GeneratedImageInfo, ImageGenerateRequest, ImageGenerateResult } from "@deyin/contract";

/** Where a generation request sends its HTTP call, and with which credential. */
export interface ImageRouting {
  apiBaseUrl: string;
  getToken: () => Promise<string | null>;
}

export type ImageRunRequest = ImageGenerateRequest & { signal?: AbortSignal };

/**
 * Call the provider's image model and hand back what it drew, without keeping anything. For a picture that is not
 * part of a conversation (a Bot's avatar), where the caller decides what to keep.
 */
export async function requestImages(
  routing: ImageRouting,
  req: Omit<ImageRunRequest, "threadId">,
): Promise<GeneratedImage[]> {
  const token = await routing.getToken();
  if (token === null) throw new Error("Signed out — sign in to Openference to generate images.");
  const capability = modelImageCapability(req.model);
  const route = capability === "none" ? "endpoint" : capability;
  const extra = imageParamsToExtra({
    negativePrompt: req.negativePrompt,
    numSteps: req.numSteps,
    guidance: req.guidance,
    seed: req.seed,
    strength: req.strength,
  });
  return generateImages({
    apiBaseUrl: routing.apiBaseUrl,
    token,
    model: req.model,
    route,
    prompt: req.prompt,
    size: req.size ?? "1024x1024",
    n: req.n ?? 1,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  });
}

/**
 * One text-to-image run: call the provider's images endpoint, then persist each
 * result in the thread's image store so the chat can embed it by file name.
 * Shared by the IPC handler (model picked directly in the composer) and the
 * agent's generate_image bridge.
 */
export async function runImageGeneration(
  store: ImageStore,
  routing: ImageRouting,
  req: ImageRunRequest,
): Promise<ImageGenerateResult> {
  const generated = await requestImages(routing, req);
  const images: GeneratedImageInfo[] = generated.map((image) => {
    const saved = store.save(req.threadId, { base64: image.base64, mediaType: image.mediaType });
    return {
      file: saved.file,
      mediaType: saved.mediaType,
      ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
    };
  });
  return { images, model: req.model };
}
