import type { DeyinBot } from "@deyin/host-core/shared";
import { fill } from "../automationFormat.js";
import { useT } from "../i18n.js";
import { BotAvatar } from "../components/BotAvatar.js";

interface BotChatHeaderProps {
  bot: DeyinBot;
  onDetails: () => void;
  onNewConversation: () => void;
  /** For a room: the Bots that can answer in it, shown as chips that mention them. */
  members?: readonly DeyinBot[];
  /** Add `@handle` to what is being written. */
  onMention?: (handle: string) => void;
}

/** The bar above a Bot's conversation: who you are talking to, with a way to their details and to start fresh. */
export function BotChatHeader({ bot, onDetails, onNewConversation, members = [], onMention }: BotChatHeaderProps) {
  const t = useT();
  return (
    <header className="bot-chat-header">
      <BotAvatar bot={bot} size={32} decorative />
      <div className="bot-chat-header__who">
        <span className="bot-chat-header__name">{bot.name}</span>
        {bot.title ? <span className="bot-chat-header__title">{bot.title}</span> : null}
      </div>
      {bot.kind === "room" && members.length > 0 ? (
        <ul className="bot-chat-header__members" aria-label={t("bot.room.membersTitle")} title={t("bot.room.mentionHint")}>
          {members.map((member) => (
            <li key={member.id}>
              <button
                type="button"
                className="bot-chat-header__member"
                aria-label={fill(t("bot.room.mention"), { name: member.name })}
                disabled={bot.archived || !onMention}
                onClick={() => onMention?.(member.handle)}
              >
                <BotAvatar bot={member} size={18} decorative />
                <span>@{member.handle}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="bot-chat-header__actions">
        <button type="button" className="btn btn--ghost" onClick={onNewConversation} disabled={bot.archived}>
          {t("bot.chat.new")}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onDetails}>
          {t("bot.chat.details")}
        </button>
      </div>
    </header>
  );
}
