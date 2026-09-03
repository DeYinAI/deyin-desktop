/**
 * Browser-safe surface of @deyin/host-core: types, config, seed data and fetch-based
 * clients. Contains no `node:` imports, so it can be bundled into the desktop renderer
 * and the web client. Node-only pieces (storage, stores, host services) live in the
 * package root export.
 */
export { parseSseDataLine as sseJsonLine, ssePayloads as sseJson } from "./sse-core.js";
export * from "./types.js";
export * from "./config.js";
export * from "./defaults.js";
export * from "./agent-run.js";
export * from "./usage.js";
export * from "./openference.js";
export * from "./search.js";
export * from "./models.js";
export * from "./model-reasoning.js";
export * from "./image-model-params.js";
export * from "./images.js";
export * from "./image-intent.js";
export * from "./image-parts.js";
export * from "./account.js";
export * from "./plans.js";
export * from "./plan-copy.js";
export * from "./plan-release.js";
export * from "./billing.js";
export * from "./identity.js";
export * from "./redact.js";
export * from "./i18n.js";
export * from "./telemetry.js";
export * from "./linked-thread-context.js";
export * from "./recent-workspaces.js";
export { formatUserMessageWithContext, dedupeContextRefs } from "./context-message.js";
export {
  DEFAULT_LOCAL_VISION_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  LOCAL_VISION_MAX_IMAGE_BYTES,
  LOCAL_VISION_MAX_IMAGES,
  checkOllamaVisionModel,
  describeImageViaOllama,
  describeImagesViaOllama,
  formatUserMessageWithLocalVision,
  resolveLocalOllamaBaseUrl,
  validateLocalVisionImages,
} from "./local-vision.js";
export type {
  LocalVisionConfig,
  LocalVisionDescription,
  LocalVisionDescribeResult,
  LocalVisionImage,
  LocalVisionStatus,
  OllamaHealth,
} from "./local-vision.js";
export { isPathInsideRoot, logicalResolve } from "./pathInside.js";
export type { ContextRef, ContextSearchHit, ResolvedContextFile } from "./types.js";
