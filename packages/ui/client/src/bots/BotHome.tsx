import type { DeyinBot } from "@deyin/host-core/shared";
import { fill } from "../automationFormat.js";
import { useT } from "../i18n.js";

type BotRef = Pick<DeyinBot, "id" | "name">;

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
  /** The person's primary Bot, when there is one: the home opens straight to it. */
  primary?: BotRef;
  onOpenPrimary?: () => void;
  /** Offered while there is no primary Bot: make a new one as the main point of contact. */
  onCreatePrimary?: () => void;
}

/** What the Bot product shows when no Bot is open: a prompt to pick one, or to make the first. */
export function BotHome({ activeCount, onCreate, onCreateRoom, onBrowse, onImport, primary, onOpenPrimary, onCreatePrimary }: BotHomeProps) {
  const t = useT();
  const intro = !primary && onCreatePrimary !== undefined;
  return (
    <div className="bot-home">
      <h2 className="bot-home__title">{activeCount === 0 ? t("bot.roster.empty") : t("bot.home.title")}</h2>
      <p className="bot-home__hint">{activeCount === 0 ? t("bot.roster.emptyHint") : t("bot.home.pick")}</p>
      {primary && onOpenPrimary ? (
        <button type="button" className="btn btn--primary" onClick={onOpenPrimary}>
          {fill(t("bot.primary.open"), { name: primary.name })}
        </button>
      ) : null}
      {intro ? (
        <section className="bot-home__intro" aria-labelledby="bot-home-intro-title">
          <h3 id="bot-home-intro-title" className="bot-home__intro-title">
            {t("bot.primary.introTitle")}
          </h3>
          <p className="bot-home__intro-body">{t("bot.primary.introBody")}</p>
          <button type="button" className="btn btn--primary" onClick={onCreatePrimary}>
            {t("bot.primary.create")}
          </button>
        </section>
      ) : null}
      <button type="button" className={`btn ${primary || intro ? "btn--outline" : "btn--primary"}`} onClick={onCreate}>
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
