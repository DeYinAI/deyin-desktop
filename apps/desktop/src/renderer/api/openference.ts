/**
 * The streaming chat client now lives in @deyin/host-core (shared by desktop, web and
 * CLI). Re-exported so renderer components keep their stable import path.
 */
export { streamChat, type StreamChatOptions } from "@deyin/host-core/shared";
