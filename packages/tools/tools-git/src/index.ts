/**
 * Git tool family plugin: the read-tier git suite.
 *
 * The mutating git tools (add/commit/branch/stash/fetch/pull/push) are
 * deliberately not registered. Each was a separate tool call, so staging,
 * committing and pushing cost three round trips — three full re-sends of the
 * transcript — for what is a single chained bash command. They stay exported
 * from `@deyin/agent-core` as `GIT_WRITE_TOOLS` for hosts that want them.
 */
import type { PluginDefinition } from "@deyin/extension-api";
import { Tools } from "@deyin/tools";
import { GIT_TOOLS } from "@deyin/agent-core";

export const GIT_FAMILY_TOOLS = [...GIT_TOOLS];

export const toolsGitPlugin: PluginDefinition = {
  name: "@deyin/plugin-tools-git",
  inject: ["tools"],
  apply: (ctx) => {
    ctx.get(Tools).add(GIT_FAMILY_TOOLS);
  },
};
