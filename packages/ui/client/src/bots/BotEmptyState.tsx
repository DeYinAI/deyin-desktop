import type { DeyinBot } from "@deyin/host-core/shared";
import { fill } from "../automationFormat.js";
import { BotAvatar } from "../components/BotAvatar.js";
import { useT } from "../i18n.js";
import { EMPTY_COPY, STARTERS, emptyKindOf } from "./botStarters.js";

interface BotEmptyStateProps {
  bot: DeyinBot;
  /** Put a starter in the composer; the person finishes it and sends it. */
  onStarter: (text: string) => void;
}

/**
 * What a Bot's empty conversation shows, in place of the project hero: who this is, what to tell it (a Bot is set
 * up by talking to it), and a few openings that put the first words in the box.
 */
export function BotEmptyState({ bot, onStarter }: BotEmptyStateProps) {
  const t = useT();
  const kind = emptyKindOf(bot);
  const copy = EMPTY_COPY[kind];
  const values = { name: bot.name };
  return (
    <div className="empty-hero bot-empty">
      <BotAvatar bot={bot} size={56} decorative />
      <h2 className="bot-empty__title">{fill(t(copy.title), values)}</h2>
      <p className="bot-empty__body">{fill(t(copy.body), values)}</p>
      <div className="empty-hero__quick-actions">
        {STARTERS[kind].map((starter) => (
          <button key={starter.label} type="button" className="empty-hero__chip" disabled={bot.archived} onClick={() => onStarter(t(starter.text))}>
            {t(starter.label)}
          </button>
        ))}
      </div>
    </div>
  );
}
