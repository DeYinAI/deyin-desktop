import { useCallback, useEffect, useRef, useState } from "react";
import type { BotMemoryFactView, BotResult, MessageKey } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { useConfirm } from "../components/ConfirmDialog.js";
import type { BotsApi } from "./botsClient.js";
import { orderMemory } from "./botMemory.js";

interface BotMemoryListProps {
  botId: string;
  actions: BotsApi;
}

export type MemoryState = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; facts: BotMemoryFactView[] };

const TYPE_LABEL: Record<BotMemoryFactView["type"], MessageKey> = {
  user: "bot.memory.type.user",
  feedback: "bot.memory.type.feedback",
  project: "bot.memory.type.project",
  reference: "bot.memory.type.reference",
};

/** What a Bot remembers: its own private facts and the ones shared with every Bot. */
export function BotMemoryList({ botId, actions }: BotMemoryListProps) {
  const t = useT();
  const { confirm } = useConfirm();
  const [state, setState] = useState<MemoryState>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (isCurrent: () => boolean): Promise<void> => {
      let next: MemoryState;
      try {
        const result = await actions.memoryList(botId);
        next = result.ok ? { status: "ready", facts: orderMemory(result.value) } : { status: "error", error: result.error };
      } catch (error) {
        next = { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
      if (isCurrent()) setState(next);
    },
    [actions, botId],
  );

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);

  /** Run a change, show a refusal, then re-read so the list is what the host holds. */
  const change = async (run: () => Promise<BotResult<unknown>>): Promise<void> => {
    let failure: string | null = null;
    try {
      const result = await run();
      if (!result.ok) failure = result.error;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (!mounted.current) return;
    setNotice(failure);
    await load(() => mounted.current);
  };

  const forget = async (fact: BotMemoryFactView): Promise<void> => {
    const accepted = await confirm({
      title: fact.title || fact.name,
      message: t("bot.memory.forgetMessage"),
      confirmLabel: t("bot.memory.forget"),
      destructive: true,
    });
    if (accepted) await change(() => actions.memoryForget(botId, fact.id));
  };

  return (
    <BotMemoryPanel
      state={state}
      notice={notice}
      onToggleShare={(fact) => void change(() => actions.memoryShare(botId, fact.id, !fact.shared))}
      onForget={(fact) => void forget(fact)}
    />
  );
}

interface BotMemoryPanelProps {
  state: MemoryState;
  notice: string | null;
  onToggleShare: (fact: BotMemoryFactView) => void;
  onForget: (fact: BotMemoryFactView) => void;
}

/** The memory section as pure markup, so every state can be rendered without a host. */
export function BotMemoryPanel({ state, notice, onToggleShare, onForget }: BotMemoryPanelProps) {
  const t = useT();
  return (
    <section className="bot-memory" aria-label={t("bot.memory.title")}>
      <h3 className="bot-detail__heading">{t("bot.memory.title")}</h3>
      {notice ? (
        <p className="hint--bad" role="alert">
          {notice}
        </p>
      ) : null}
      {state.status === "loading" ? <p className="hint" role="status">{t("bot.memory.loading")}</p> : null}
      {state.status === "error" ? (
        <p className="hint--bad" role="alert">
          {t("bot.memory.loadError")} {state.error}
        </p>
      ) : null}
      {state.status === "ready" && state.facts.length === 0 ? <p className="hint">{t("bot.memory.empty")}</p> : null}
      {state.status === "ready" && state.facts.length > 0 ? (
        <ul className="bot-memory__list">
          {state.facts.map((fact) => (
            <li key={fact.id} className="bot-memory__item">
              <div className="bot-memory__head">
                <strong className="bot-memory__title">{fact.title || fact.name}</strong>
                <span className="bot-memory__badge">{t(TYPE_LABEL[fact.type])}</span>
                <span className={`bot-memory__badge${fact.shared ? " bot-memory__badge--shared" : ""}`}>
                  {fact.shared ? t("bot.memory.shared") : t("bot.memory.private")}
                </span>
              </div>
              {fact.description ? <p className="bot-memory__description">{fact.description}</p> : null}
              <div className="bot-memory__actions">
                <button type="button" className="btn btn--ghost" onClick={() => onToggleShare(fact)}>
                  {fact.shared ? t("bot.memory.makePrivate") : t("bot.memory.share")}
                </button>
                <button type="button" className="btn btn--ghost btn--danger" onClick={() => onForget(fact)}>
                  {t("bot.memory.forget")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
