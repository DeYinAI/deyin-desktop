import { generateImages, type ImageStore } from "@deyin/host-core";
import type { GeneratedImageInfo, ImageGenerateResult } from "@deyin/contract";

/** Where a generation request sends its HTTP call, and with which credential. */
export interface ImageRouting {
  apiBaseUrl: string;
  getToken: () => Promise<string | null>;
}

export interface ImageRunRequest {
  threadId: string;
  prompt: string;
  model: string;
  size?: string;
  n?: number;
  negativePrompt?: string;
  signal?: AbortSignal;
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
  const token = await routing.getToken();
  if (token === null) throw new Error("Signed out — sign in to Openference to generate images.");
  const generated = await generateImages({
    apiBaseUrl: routing.apiBaseUrl,
    token,
    model: req.model,
    prompt: req.prompt,
    size: req.size ?? "1024x1024",
    n: req.n ?? 1,
    ...(req.negativePrompt ? { extra: { negative_prompt: req.negativePrompt } } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  });
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
