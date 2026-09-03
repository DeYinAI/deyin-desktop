import { generateVideo, type VideoStore } from "@deyin/host-core";
import { videoParamsToExtra } from "@deyin/host-core";
import type { GeneratedVideoInfo, VideoGenerateRequest, VideoGenerateResult } from "@deyin/contract";

/** Where a generation request sends its HTTP call, and with which credential. */
export interface VideoRouting {
  apiBaseUrl: string;
  getToken: () => Promise<string | null>;
}

export type VideoRunRequest = VideoGenerateRequest & { signal?: AbortSignal };

/**
 * One text-to-video run: call POST /v1/videos, poll until complete, then persist
 * the result in the thread's video store so the chat can embed it by file name.
 */
export async function runVideoGeneration(
  store: VideoStore,
  routing: VideoRouting,
  req: VideoRunRequest,
): Promise<VideoGenerateResult> {
  const token = await routing.getToken();
  if (token === null) throw new Error("Signed out — sign in to Openference to generate videos.");
  const extra = videoParamsToExtra({
    aspectRatio: req.aspectRatio,
    width: req.width,
    height: req.height,
    numFrames: req.numFrames,
    frameRate: req.frameRate,
    numInferenceSteps: req.numInferenceSteps,
    negativePrompt: req.negativePrompt,
    seed: req.seed,
    mode: req.mode,
  });
  const generated = await generateVideo({
    apiBaseUrl: routing.apiBaseUrl,
    token,
    model: req.model,
    prompt: req.prompt,
    inputImages: req.inputImages,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  const saved = store.save(req.threadId, { base64: generated.base64, mediaType: generated.mediaType });
  const video: GeneratedVideoInfo = { file: saved.file, mediaType: saved.mediaType };
  return { video, model: req.model };
}
