import type { ToolDefinition, ToolRegistry } from "@deyin/agent-core";
import type { SecureFormRequest } from "@deyin/host-core/shared";
import { createOnePasswordTools } from "./onepassword-tools.js";
import type { OnePasswordPort } from "./onepassword.js";
import { redactToolResults } from "./vault-redaction.js";
import { createVaultTools, type VaultAccess, type VaultAnswer, type VaultApproval, type VaultPageSource, type VaultSurface } from "./vault-tools.js";

/** The people a run can turn to. A run nobody is watching (a routine) has none, and so can only use what was agreed before. */
export interface VaultRunPeople {
  ask: (request: VaultApproval) => Promise<VaultAnswer>;
  takeover: (reason: string) => Promise<"done" | "declined">;
  secureForm: (request: SecureFormRequest) => Promise<Record<string, string> | null>;
}

/** The Vault, as the tools and the redaction use it. `VaultStore` provides it. */
export type VaultRunStore = VaultAccess & { secretValues(): readonly string[] };

export interface VaultRunOptions {
  vault: VaultRunStore;
  botId: string;
  /** The browsers this run actually has tools for. Without one there is nothing to fill into. */
  pages: Partial<Record<VaultSurface, VaultPageSource>>;
  people?: VaultRunPeople;
  /** The person's 1Password, when they have turned it on. Without it the Bot has only the Vault. */
  onePassword?: OnePasswordPort;
}

/** One Bot run's use of the Vault: its tools, and the cover that keeps secrets out of everything the Bot reads. */
export interface VaultRun {
  /** The Vault tools for the run's own registry; empty when the run has no browser. */
  tools(): ToolDefinition[];
  /** The Vault tools a subagent may have: only those its tool list names, and only for the in-app browser. */
  subagentTools(allow: readonly string[] | undefined): ToolDefinition[];
  /** Every value that must not reach the Bot: what is saved, and what a person typed into a Secure Form. */
  secrets(): readonly string[];
  /** Scrub the result of every tool in `registry` as it stands now. */
  protect(registry: ToolRegistry): void;
}

export function createVaultRun(options: VaultRunOptions): VaultRun {
  const typed = new Set<string>();
  const hide = (value: string): void => void typed.add(value);
  const build = (pages: VaultRunOptions["pages"]): ToolDefinition[] =>
    Object.keys(pages).length === 0
      ? []
      : [
          ...createVaultTools({
            vault: options.vault,
            botId: options.botId,
            pages,
            ...(options.people ? { ask: options.people.ask, takeover: options.people.takeover, secureForm: options.people.secureForm } : {}),
            hide,
          }),
          ...(options.onePassword
            ? createOnePasswordTools({ onePassword: options.onePassword, botId: options.botId, pages, ...(options.people ? { ask: options.people.ask } : {}), hide })
            : []),
        ];
  const secrets = (): readonly string[] => [...options.vault.secretValues(), ...typed];
  return {
    tools: () => build(options.pages),
    subagentTools: (allow) => {
      if (!allow || !options.pages.browser) return [];
      const named = new Set(allow);
      return build({ browser: options.pages.browser }).filter((tool) => named.has(tool.name));
    },
    secrets,
    protect: (registry) => redactToolResults(registry, secrets),
  };
}
