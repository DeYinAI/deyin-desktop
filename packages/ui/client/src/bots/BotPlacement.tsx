import { useEffect, useRef, useState } from "react";
import type { DeyinBot, EngineHostView } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import type { BotsApi } from "./botsClient.js";
import {
  attemptServerList,
  attemptServers,
  placeChoices,
  placeHealth,
  placeNotes,
  placePatch,
  placeValue,
  type PlaceChoice,
  type PlaceHealth,
  type ServersApi,
} from "./botServers.js";

export interface BotPlacementViewProps {
  bot: Pick<DeyinBot, "id" | "harness" | "hostId" | "autoReview" | "archived">;
  choices: readonly PlaceChoice[];
  /** Null before it has been asked, or for a Bot that runs here. */
  health: PlaceHealth | null;
  /** The change is being saved. */
  busy: boolean;
  error: string | null;
  onChange: (value: string) => void;
  /** Opens the page where an engine is set up on a server; absent where there is none. */
  onOpenServers?: () => void;
}

/** The choice of the computer a Bot works on, and what the person should know about the one chosen. */
export function BotPlacementView({ bot, choices, health, busy, error, onChange, onOpenServers }: BotPlacementViewProps) {
  const t = useT();
  const notes = placeNotes(bot);
  return (
    <section className="bot-place" aria-label={t("bot.place.title")}>
      <h3 className="bot-detail__heading">{t("bot.place.title")}</h3>
      <p className="hint">{t("bot.place.hint")}</p>
      <div className="bot-place__row">
        <label className="field__label" htmlFor="bot-place-select">
          {t("bot.place.label")}
        </label>
        <select id="bot-place-select" className="input" value={placeValue(bot)} disabled={busy || bot.archived} onChange={(event) => onChange(event.target.value)}>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value} disabled={choice.unavailable !== null && choice.value !== placeValue(bot)}>
              {choiceText(choice, t)}
            </option>
          ))}
        </select>
        {onOpenServers ? (
          <button type="button" className="btn btn--ghost" onClick={onOpenServers}>
            {t("bot.place.manage")}
          </button>
        ) : null}
      </div>
      {health ? <HealthLine health={health} /> : null}
      {notes.length > 0 ? (
        <ul className="bot-place__notes">
          {notes.map((key) => (
            <li key={key} className="hint">
              {t(key)}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="hint--bad" role="alert" hidden={!error}>
        {error}
      </p>
    </section>
  );
}

function choiceText(choice: PlaceChoice, t: ReturnType<typeof useT>): string {
  if (choice.label === null && choice.unavailable === null) return t("bot.place.local");
  const name = choice.label ?? "";
  return choice.unavailable ? (name ? `${name} (${t(choice.unavailable)})` : t(choice.unavailable)) : name;
}

function HealthLine({ health }: { health: PlaceHealth }) {
  const t = useT();
  switch (health.status) {
    case "checking":
      return (
        <p className="hint" role="status">
          {t("bot.place.health.checking")}
        </p>
      );
    case "ready":
      return (
        <p className="hint" role="status">
          {health.version ? fill(t("bot.place.health.readyVersion"), { version: health.version }) : t("bot.place.health.ready")}
        </p>
      );
    case "notReady":
      return (
        <p className="hint--bad" role="status">
          {fill(t("bot.place.health.notReady"), { reason: health.reason })}
        </p>
      );
    default: {
      const unhandled: never = health;
      throw new Error(`Unhandled place health: ${JSON.stringify(unhandled)}`);
    }
  }
}

interface BotPlacementProps {
  bot: DeyinBot;
  actions: BotsApi;
  api: ServersApi;
  onOpenServers?: () => void;
}

/** Where a Bot runs, with the saved servers it could run on and whether the one it is set to is ready. */
export function BotPlacement({ bot, actions, api, onOpenServers }: BotPlacementProps) {
  const [hosts, setHosts] = useState<EngineHostView[]>([]);
  const [health, setHealth] = useState<PlaceHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    const stop = api.onChange((list) => {
      if (current) setHosts(list);
    });
    void attemptServerList(api).then((outcome) => {
      if (current && outcome.ok) setHosts((existing) => (existing.length > 0 ? existing : outcome.value));
    });
    return () => {
      current = false;
      stop();
    };
  }, [api]);

  // Asked again when the Bot moves, and when a server's engine is set up or removed.
  useEffect(() => {
    if (bot.harness !== "server") {
      setHealth(null);
      return;
    }
    let current = true;
    setHealth({ status: "checking" });
    void attemptServers(() => api.health(bot.id)).then((outcome) => {
      if (current) setHealth(placeHealth(outcome));
    });
    return () => {
      current = false;
    };
  }, [api, bot.id, bot.harness, bot.hostId, hosts]);

  const change = async (value: string): Promise<void> => {
    const patch = placePatch(value);
    if (!patch || value === placeValue(bot)) return;
    setBusy(true);
    setError(null);
    const outcome = await attemptServers(() => actions.update(bot.id, patch));
    if (!mounted.current) return;
    setBusy(false);
    if (!outcome.ok) setError(outcome.error);
  };

  return <BotPlacementView bot={bot} choices={placeChoices(hosts, bot)} health={health} busy={busy} error={error} onChange={(value) => void change(value)} {...(onOpenServers ? { onOpenServers } : {})} />;
}
