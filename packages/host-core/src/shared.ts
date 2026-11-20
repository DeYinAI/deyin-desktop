/**
 * Browser-safe surface of @deyin/host-core: types, config, seed data and fetch-based
 * clients. Contains no `node:` imports, so it can be bundled into the desktop renderer
 * and the web client. Node-only pieces (storage, stores, host services) live in the
 * package root export.
 */
export {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  parseSseDataLine as sseJsonLine,
  ssePayloads as sseJson,
} from "./sse-core.js";
export * from "./types.js";
export * from "./automation-status.js";
export * from "./automation-run-view.js";
export * from "./automation-policy.js";
export * from "./config.js";
export * from "./defaults.js";
export * from "./conductor-roles.js";
export * from "./legacy-conductor.js";
export * from "./products.js";
export * from "./bots/avatar.js";
export * from "./bots/avatar-image.js";
export * from "./bots/types.js";
export * from "./bots/layout.js";
export * from "./bots/persona.js";
export * from "./bots/room.js";
export * from "./bots/threads.js";
export * from "./bots/state.js";
export * from "./bots/permissions.js";
export * from "./bots/review.js";
export * from "./bots/routines.js";
export * from "./bots/onepassword.js";
export * from "./bots/vault.js";
export * from "./bots/vault-sites.js";
export * from "./bots/secure-form.js";
export * from "./bots/runtime.js";
export * from "./bots/skills.js";
export * from "./bots/template.js";
export * from "./bots/teach.js";
export * from "./bots/panel-view.js";
export * from "./bots/catalog.js";
export * from "./bots/surfaces.js";
export * from "./bots/engine-protocol.js";
export * from "./bots/engine-view.js";
export * from "./conductor-templates.js";
export * from "./agent-run.js";
export * from "./run-notices.js";
export * from "./usage.js";
export * from "./openference.js";
export * from "./search.js";
export * from "./models.js";
export * from "./model-reasoning.js";
export * from "./image-model-params.js";
export * from "./video-model-params.js";
export * from "./images.js";
export * from "./videos.js";
export * from "./image-intent.js";
export * from "./video-intent.js";
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
export * from "./user-agent.js";
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
export {
  checkpointIdsFromEventsAfterIndex,
  collectCheckpointIdsInThread,
  inferCheckpointOperation,
  isRevertableStopThought,
} from "./checkpoint-events.js";
export type { RevertResult, FileCheckpointEntry } from "./types.js";
export { fromWslPath, mapPosixOntoWslUnc, toWslPath, wslUncDistro, WSL_UNC_RE } from "./host/wsl-path.js";
export type { ContextRef, ContextSearchHit, ResolvedContextFile } from "./types.js";
