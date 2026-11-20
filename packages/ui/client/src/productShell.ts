import { botThreads, type ChatMode, type DeyinBot, type Project, type ProductId, type Thread } from "@deyin/host-core/shared";

/** What picking a composer mode means once Conductor is a product of its own. */
export type ModeRoute =
  /** The mode belongs to another product, so the shell switches (and the composer takes `mode`). */
  | { kind: "switch-product"; product: ProductId; mode: ChatMode }
  /** The mode is one of the current product's own. */
  | { kind: "set-mode"; mode: ChatMode }
  /** The current product has no such mode. */
  | { kind: "ignore" };

/**
 * Conductor is not a Code composer mode any more: choosing it (the pill, `/conductor`, Ctrl+Shift+B)
 * moves into the Conductor product, and leaving it for any other mode moves back to Code. A Bot offers
 * one mode, so a Code-only mode is ignored there instead of leaking into a Bot's chat.
 */
export function routeMode(mode: ChatMode, product: ProductId, hostHasRuntime: boolean): ModeRoute {
  if (mode === "conductor") {
    if (!hostHasRuntime) return { kind: "ignore" };
    return product === "conductor" ? { kind: "set-mode", mode } : { kind: "switch-product", product: "conductor", mode };
  }
  switch (product) {
    case "conductor":
      return { kind: "switch-product", product: "code", mode };
    case "bot":
      return mode === "agent" ? { kind: "set-mode", mode } : { kind: "ignore" };
    case "code":
      return { kind: "set-mode", mode };
    default: {
      const unhandled: never = product;
      throw new Error(`Unhandled product: ${String(unhandled)}`);
    }
  }
}

/** The conversation a Bot opens on: its most recently active live one, or null when it has none yet. */
export function threadToOpenForBot(projects: readonly Project[], botId: string): Thread | null {
  return botThreads(projects, botId)[0] ?? null;
}

/**
 * The Bot the open conversation belongs to, or null: no conversation, a Code or Conductor conversation,
 * or a Bot that no longer exists. Never guesses a different Bot.
 */
export function botOfThread(thread: Pick<Thread, "botId"> | null, bots: readonly DeyinBot[]): DeyinBot | null {
  if (!thread?.botId) return null;
  return bots.find((bot) => bot.id === thread.botId) ?? null;
}
