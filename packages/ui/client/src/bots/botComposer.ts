import type { BotApprovalMode, DeyinBot, MessageKey } from "@deyin/host-core/shared";
import { fill } from "../automationFormat.js";

type Translate = (key: MessageKey) => string;

/**
 * What a Bot's conversation shows in the message box where a coding session shows its own controls. The coding
 * session's access setting does nothing in a Bot's chat: the Bot's own approval mode decides what asks, so the box
 * says that one instead, and a click goes to where it is changed.
 */
export interface BotComposerChrome {
  placeholder: string;
  /** The Bot's approval mode, in words. */
  approvalLabel: string;
  approvalTitle: string;
  approvalIcon: "shield" | "hand" | "eye";
  /** A mode where nothing asks is drawn as a warning, as a coding session's full access is. */
  approvalWarn: boolean;
  onOpenApproval: () => void;
}

function approvalLabelKey(mode: BotApprovalMode): MessageKey {
  switch (mode) {
    case "auto_review":
      return "bot.permissions.mode.auto_review";
    case "read_only":
      return "bot.permissions.mode.read_only";
    case "run_everything":
      return "bot.permissions.mode.run_everything";
    default: {
      const unhandled: never = mode;
      throw new Error(`Unhandled approval mode: ${String(unhandled)}`);
    }
  }
}

function approvalIcon(mode: BotApprovalMode): BotComposerChrome["approvalIcon"] {
  switch (mode) {
    case "auto_review":
      return "hand";
    case "read_only":
      return "eye";
    case "run_everything":
      return "shield";
    default: {
      const unhandled: never = mode;
      throw new Error(`Unhandled approval mode: ${String(unhandled)}`);
    }
  }
}

function placeholderKey(bot: Pick<DeyinBot, "kind" | "isPrimary">, hasTeam: boolean): MessageKey {
  if (bot.kind === "room") return "bot.composer.placeholderRoom";
  return bot.isPrimary && hasTeam ? "bot.composer.placeholderPrimary" : "bot.composer.placeholder";
}

/** `hasTeam`: the Bot has others to hand work to, so `@` is worth mentioning in the box. */
export function botComposerChrome(
  bot: Pick<DeyinBot, "name" | "kind" | "isPrimary" | "autoReview">,
  hasTeam: boolean,
  t: Translate,
  onOpenApproval: () => void,
): BotComposerChrome {
  const mode = bot.autoReview.approvalMode;
  return {
    placeholder: fill(t(placeholderKey(bot, hasTeam)), { name: bot.name }),
    approvalLabel: t(approvalLabelKey(mode)),
    approvalTitle: fill(t("bot.composer.approvalTitle"), { name: bot.name }),
    approvalIcon: approvalIcon(mode),
    approvalWarn: mode === "run_everything",
    onOpenApproval,
  };
}
