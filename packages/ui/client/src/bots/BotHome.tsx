import { useT } from "../i18n.js";

interface BotHomeProps {
  /** How many Bots can be chatted with (archived ones do not count). */
  activeCount: number;
  onCreate: () => void;
  /** Make a room of several Bots; absent until there are enough Bots for one. */
  onCreateRoom?: () => void;
  /** Open the marketplace; absent where there is none. */
  onBrowse?: () => void;
  /** Add a Bot someone shared; absent where there is no way to. */
  onImport?: () => void;
}

/** What the Bot product shows when no Bot is open: a prompt to pick one, or to make the first. */
export function BotHome({ activeCount, onCreate, onCreateRoom, onBrowse, onImport }: BotHomeProps) {
  const t = useT();
  return (
    <div className="bot-home">
      <h2 className="bot-home__title">{activeCount === 0 ? t("bot.roster.empty") : t("bot.home.title")}</h2>
      <p className="bot-home__hint">{activeCount === 0 ? t("bot.roster.emptyHint") : t("bot.home.pick")}</p>
      <button type="button" className="btn btn--primary" onClick={onCreate}>
        {t("bot.create.submit")}
      </button>
      {onCreateRoom ? (
        <button type="button" className="btn btn--outline" onClick={onCreateRoom}>
          {t("bot.room.new")}
        </button>
      ) : null}
      {onBrowse ? (
        <button type="button" className="btn btn--outline" onClick={onBrowse}>
          {t("bot.market.discover")}
        </button>
      ) : null}
      {onImport ? (
        <button type="button" className="btn btn--ghost" onClick={onImport}>
          {t("bot.market.import")}
        </button>
      ) : null}
    </div>
  );
}
