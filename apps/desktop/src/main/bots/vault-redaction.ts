import type { ToolDefinition, ToolRegistry } from "@deyin/agent-core";
import { redactSecrets } from "@deyin/host-core/shared";

/**
 * Keeps saved secrets out of what a Bot reads. A Bot never asks for a password, but a page it is looking at can
 * show one it just filled in (a card number typed into a text field appears in a snapshot). Every result of
 * every tool it can use passes through `redactSecrets` first, whatever the tool is.
 */

/** `tool`, with its result, its streamed output and any error message scrubbed of `secrets()` (read on every call). */
export function redactTool(tool: ToolDefinition, secrets: () => readonly string[]): ToolDefinition {
  const scrub = (text: string): string => redactSecrets(text, secrets());
  return {
    ...tool,
    async execute(args, ctx) {
      const guarded = ctx.onOutput ? { ...ctx, onOutput: (delta: string) => ctx.onOutput?.(scrub(delta)) } : ctx;
      try {
        return scrub(await tool.execute(args, guarded));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The original error is deliberately not attached as the cause: it may still hold a secret the message was scrubbed of.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(scrub(message));
      }
    },
  };
}

/** Wrap every tool in `registry` as it stands now. Call it after the run's tools are all registered. */
export function redactToolResults(registry: ToolRegistry, secrets: () => readonly string[]): void {
  for (const name of registry.names()) {
    const tool = registry.get(name);
    if (tool) registry.register(redactTool(tool, secrets));
  }
}
