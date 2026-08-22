/**
 * Shared helpers for agent E2E integration tests.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../../src/loop.js";
import { PermissionEngine } from "../../src/permissions.js";
import { createBuiltinRegistry } from "../../src/tools/index.js";
import type { AgentMessage, TodoItem } from "../../src/types.js";
import { startMockOpenAI, textResponse, toolCallResponse } from "../helpers/mock-openai.js";

export { startMockOpenAI, textResponse, toolCallResponse };

export interface E2EAgentOpts {
  cwd: string;
  apiUrl: string;
  messages: AgentMessage[];
  script: (i: number) => ReturnType<typeof textResponse>;
  todos?: TodoItem[];
  evidenceGatesEnabled?: boolean;
  maxSteps?: number;
}

/** Run a full agent turn sequence against the mock API. */
export async function runE2EAgent(opts: E2EAgentOpts) {
  const server = await startMockOpenAI(opts.script);
  try {
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "e2e-token",
      model: "test-model",
      messages: opts.messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd: opts.cwd,
      todos: opts.todos,
      evidenceGatesEnabled: opts.evidenceGatesEnabled,
      maxSteps: opts.maxSteps ?? 10,
    });
    return { result, requests: server.requests };
  } finally {
    await server.close();
  }
}

/** Seed a minimal multi-file refactor workspace. */
export function seedRefactorWorkspace(cwd: string): void {
  mkdirSync(join(cwd, "src", "auth"), { recursive: true });
  mkdirSync(join(cwd, "src", "api"), { recursive: true });
  writeFileSync(join(cwd, "src", "auth", "handler.ts"), "export function auth() { return true; }\n");
  writeFileSync(join(cwd, "src", "auth", "middleware.ts"), "export function mw() {}\n");
  writeFileSync(join(cwd, "src", "api", "routes.ts"), "import { auth } from '../auth/handler';\n");
}

/** Response with cache hit tokens in usage (simulates DeepSeek prefix cache). */
export function textResponseWithCache(text: string, cachedTokens: number, newTokens: number): unknown[] {
  return [
    { choices: [{ delta: { content: text } }] },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: cachedTokens + newTokens,
        completion_tokens: 5,
        total_tokens: cachedTokens + newTokens + 5,
        prompt_cache_hit_tokens: cachedTokens,
        prompt_cache_miss_tokens: newTokens,
      },
    },
  ];
}
