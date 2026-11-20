import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogCard, CatalogListing, ImportedBot } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { PageHeader } from "../components/settings/controls.js";
import { attempt } from "./botCalls.js";
import type { RoutineDefaults } from "./botRoutines.js";
import { CATEGORY_FILTERS, categoryArg, categoryKey, comesWithLine, getKey, importBlocked, importedLines, type CategoryFilter, type TemplatesApi } from "./botTemplates.js";

export type MarketState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; listing: CatalogListing };

interface BotMarketplacePanelProps {
  state: MarketState;
  query: string;
  category: CategoryFilter;
  /** The starter being added, while one is. */
  busyId: string | null;
  notice: string | null;
  /** The Bot added last, shown until the person does something else. */
  added: ImportedBot | null;
  /** Why a starter that comes with routines cannot be added yet, or null. */
  needsModel: boolean;
  onQuery: (query: string) => void;
  onCategory: (category: CategoryFilter) => void;
  onGet: (card: CatalogCard) => void;
  onOpen: (botId: string) => void;
  onImport: () => void;
  onBack: () => void;
}

function Card({ card, busy, disabled, onGet }: { card: CatalogCard; busy: boolean; disabled: boolean; onGet: () => void }) {
  const t = useT();
  const line = comesWithLine(card);
  return (
    <li className="bot-market__card">
      <div className="bot-panel__main">
        <strong className="bot-panel__name">{card.name}</strong>
        {card.title ? <span className="bot-panel__meta">{card.title}</span> : null}
        <p>{card.blurb}</p>
        <span className="bot-panel__badge">{t(categoryKey(card.category))}</span>
        <span className="bot-panel__meta">{fill(t(line.key), line.vars)}</span>
        {card.have ? <span className="bot-panel__meta">{t("bot.market.have")}</span> : null}
      </div>
      <div className="bot-panel__actions">
        <button type="button" className="btn btn--outline" disabled={disabled} onClick={onGet}>
          {busy ? t("bot.share.adding") : t(getKey(card))}
        </button>
      </div>
    </li>
  );
}

/** The marketplace as pure markup: starters to add, a few picked for the person, and a way to add a shared Bot. */
export function BotMarketplacePanel(props: BotMarketplacePanelProps) {
  const { state, busyId, added } = props;
  const t = useT();
  return (
    <section className="bot-market" aria-label={t("bot.market.title")}>
      <PageHeader title={t("bot.market.title")} description={t("bot.market.hint")}>
        <button type="button" className="btn btn--ghost" onClick={props.onBack}>
          {t("bot.detail.back")}
        </button>
        <button type="button" className="btn btn--outline" onClick={props.onImport}>
          {t("bot.market.import")}
        </button>
      </PageHeader>
      <div className="bot-market__filters">
        <label className="field__label" htmlFor="bot-market-search">
          {t("bot.market.search")}
        </label>
        <input id="bot-market-search" type="search" className="input" value={props.query} placeholder={t("bot.market.searchPlaceholder")} autoComplete="off" onChange={(event) => props.onQuery(event.target.value)} />
        <div className="bot-panel__tabs" role="group" aria-label={t("bot.market.categories")}>
          {CATEGORY_FILTERS.map((one) => (
            <button key={one} type="button" aria-pressed={props.category === one} className={`btn ${props.category === one ? "btn--outline" : "btn--ghost"}`} onClick={() => props.onCategory(one)}>
              {t(categoryKey(one))}
            </button>
          ))}
        </div>
      </div>
      {props.notice ? (
        <p className="hint--bad" role="alert">
          {props.notice}
        </p>
      ) : null}
      {added ? (
        <p role="status">
          {importedLines(added)
            .map((line) => fill(t(line.key), line.vars))
            .join(" ")}{" "}
          <button type="button" className="btn btn--ghost" onClick={() => props.onOpen(added.bot.id)}>
            {t("bot.share.openBot")}
          </button>
        </p>
      ) : null}
      {props.needsModel ? <p className="hint">{t("bot.share.problem.noModel")}</p> : null}
      {state.status === "loading" ? (
        <p className="hint" role="status">
          {t("bot.market.loading")}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="hint--bad" role="alert">
          {t("bot.market.loadError")} {state.error}
        </p>
      ) : null}
      {state.status === "ready" && state.listing.forYou.length > 0 ? (
        <section aria-label={t("bot.market.forYou")}>
          <h3 className="bot-detail__heading">{t("bot.market.forYou")}</h3>
          <p className="hint">{t("bot.market.forYouHint")}</p>
          <ul className="bot-market__grid">
            {state.listing.forYou.map((card) => (
              <Card key={card.id} card={card} busy={busyId === card.id} disabled={busyId !== null} onGet={() => props.onGet(card)} />
            ))}
          </ul>
        </section>
      ) : null}
      {state.status === "ready" ? (
        <section aria-label={t("bot.market.browse")}>
          <h3 className="bot-detail__heading">{t("bot.market.browse")}</h3>
          {state.listing.browse.length === 0 ? <p className="hint">{t("bot.market.none")}</p> : null}
          <ul className="bot-market__grid">
            {state.listing.browse.map((card) => (
              <Card key={card.id} card={card} busy={busyId === card.id} disabled={busyId !== null} onGet={() => props.onGet(card)} />
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

interface BotMarketplaceProps {
  api: TemplatesApi;
  defaults: RoutineDefaults;
  onOpenBot: (botId: string) => void;
  onImport: () => void;
  onBack: () => void;
}

/** Starters to add a Bot from. A starter is a new Bot like any other: its own memory, its routines paused until turned on. */
export function BotMarketplace({ api, defaults, onOpenBot, onImport, onBack }: BotMarketplaceProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [listing, setListing] = useState<CatalogListing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [added, setAdded] = useState<ImportedBot | null>(null);
  const [needsModel, setNeedsModel] = useState(false);
  const mounted = useRef(true);
  /** Counts what was asked for, so a slow answer to an earlier search cannot replace the one being looked at. */
  const asks = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    asks.current += 1;
    const mine = asks.current;
    const outcome = await attempt(() => api.catalog(query, categoryArg(category)));
    if (!mounted.current || mine !== asks.current) return;
    if (outcome.ok) {
      setListing(outcome.value);
      setLoadError(null);
    } else {
      setLoadError(outcome.error);
    }
  }, [api, query, category]);

  useEffect(() => {
    void load();
  }, [load]);

  const get = async (card: CatalogCard): Promise<void> => {
    if (busyId !== null) return;
    setNotice(null);
    setAdded(null);
    // The routines a starter comes with run on a model the person has, so one must be chosen before it is added.
    const block = importBlocked(card.routines, defaults);
    setNeedsModel(block !== null);
    if (block) return;
    setBusyId(card.id);
    const outcome = await attempt(() => api.importCatalog(card.id, { model: defaults.model, providerId: defaults.providerId }));
    if (!mounted.current) return;
    setBusyId(null);
    if (outcome.ok) {
      setAdded(outcome.value);
      void load();
    } else {
      setNotice(outcome.error);
    }
  };

  const state: MarketState = loadError ? { status: "error", error: loadError } : listing === null ? { status: "loading" } : { status: "ready", listing };

  return (
    <BotMarketplacePanel
      state={state}
      query={query}
      category={category}
      busyId={busyId}
      notice={notice}
      added={added}
      needsModel={needsModel}
      onQuery={setQuery}
      onCategory={setCategory}
      onGet={(card) => void get(card)}
      onOpen={onOpenBot}
      onImport={onImport}
      onBack={onBack}
    />
  );
}
