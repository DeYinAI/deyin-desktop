import { useState, type FormEvent } from "react";
import { buildBotRoster, type BotRosterLayout, type DeyinBot, type MessageKey } from "@deyin/host-core/shared";
import type { BotResult } from "@deyin/contract";
import { useT } from "../i18n.js";
import { AnchoredMenu } from "../components/AnchoredMenu.js";
import { BotAvatar } from "../components/BotAvatar.js";
import { useConfirm } from "../components/ConfirmDialog.js";
import { Icon } from "../components/Icon.js";
import type { BotsApi } from "./botsClient.js";
import { addedSectionId, botMenuActions, type BotMenuAction } from "./botMenu.js";

/** A conversation as the roster shows it. */
export interface BotConversation {
  id: string;
  title: string;
}

/** How many of the open Bot's conversations the roster lists; older ones stay reachable through search. */
export const ROSTER_CONVERSATION_LIMIT = 8;

interface BotRosterListProps {
  bots: DeyinBot[];
  layout: BotRosterLayout;
  ready: boolean;
  loadError: string | null;
  activeBotId: string | null;
  /** The open Bot's live conversations, newest first. Listed under its row. */
  conversations?: readonly BotConversation[];
  activeThreadId?: string | null;
  onSelectConversation?: (threadId: string) => void;
  actions: BotsApi;
  /** Open this Bot's conversation. */
  onSelect: (botId: string) => void;
  /** Open this Bot's details page. */
  onDetails: (botId: string) => void;
  /** The Bot is gone for good, so the caller can drop what it kept for it (its conversations). */
  onDeleted: (botId: string) => void;
  /** Open the marketplace; absent where there is none, which hides the link. */
  onBrowse?: () => void;
  /** Open the "New room" dialog. */
  onNewRoom?: () => void;
}

/** Where the inline name field is open: naming a new section (optionally for one Bot) or renaming one. */
type NameEditor = { mode: "create"; botId: string | null } | { mode: "rename"; sectionId: string; name: string };

const MENU_LABEL: Record<Exclude<BotMenuAction["kind"], "section">, MessageKey> = {
  details: "bot.menu.details",
  pin: "bot.menu.pin",
  unpin: "bot.menu.unpin",
  hide: "bot.menu.hide",
  show: "bot.menu.show",
  newSection: "bot.menu.newSection",
  noSection: "bot.menu.noSection",
  makePrimary: "bot.menu.makePrimary",
  archive: "bot.menu.archive",
  restore: "bot.menu.restore",
  delete: "bot.menu.delete",
};

export function BotRosterList(props: BotRosterListProps) {
  const t = useT();
  const { confirm } = useConfirm();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editor, setEditor] = useState<NameEditor | null>(null);
  const [draftName, setDraftName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const roster = buildBotRoster(props.bots, props.layout);
  const { actions } = props;

  /** Run a host call; a refusal becomes the notice, success clears it. */
  const settle = async <T,>(call: Promise<BotResult<T>>): Promise<BotResult<T>> => {
    const result = await call;
    setNotice(result.ok ? null : result.error);
    return result;
  };

  const perform = async (bot: DeyinBot, action: BotMenuAction): Promise<void> => {
    setMenuFor(null);
    switch (action.kind) {
      case "details":
        props.onDetails(bot.id);
        return;
      case "pin":
      case "unpin":
        await settle(actions.setPinned(bot.id, action.kind === "pin"));
        return;
      case "hide":
      case "show":
        await settle(actions.setHidden(bot.id, action.kind === "hide"));
        return;
      case "section":
        await settle(actions.moveToSection(bot.id, action.sectionId));
        return;
      case "noSection":
        await settle(actions.moveToSection(bot.id, null));
        return;
      case "newSection":
        setDraftName("");
        setEditor({ mode: "create", botId: bot.id });
        return;
      case "makePrimary":
        await settle(actions.setPrimary(bot.id));
        return;
      case "archive":
        await settle(actions.archive(bot.id));
        return;
      case "restore":
        await settle(actions.restore(bot.id));
        return;
      case "delete": {
        const accepted = await confirm({
          title: bot.name,
          message: t("bot.manage.deleteMessage"),
          confirmLabel: t("bot.manage.deleteConfirm"),
          destructive: true,
        });
        if (!accepted) return;
        const result = await settle(actions.delete(bot.id));
        if (result.ok) props.onDeleted(bot.id);
        return;
      }
      default: {
        const unhandled: never = action;
        throw new Error(`Unhandled Bot action: ${JSON.stringify(unhandled)}`);
      }
    }
  };

  const submitName = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const name = draftName.trim();
    if (!editor || !name) return;
    const current = editor;
    setEditor(null);
    if (current.mode === "rename") {
      await settle(actions.renameSection(current.sectionId, name));
      return;
    }
    const added = await settle(actions.addSection(name));
    if (!added.ok || !current.botId) return;
    const sectionId = addedSectionId(props.layout, added.value);
    if (sectionId) await settle(actions.moveToSection(current.botId, sectionId));
  };

  /** The conversations listed under a Bot's row: only the open Bot has any, newest first, and only the newest few. */
  const shownConversations = (bot: DeyinBot): readonly BotConversation[] =>
    bot.id === props.activeBotId ? (props.conversations ?? []).slice(0, ROSTER_CONVERSATION_LIMIT) : [];

  const conversationList = (bot: DeyinBot) => {
    const shown = shownConversations(bot);
    if (shown.length === 0) return null;
    return (
      <ul className="bot-row__threads" aria-label={`${t("bot.chat.conversations")}: ${bot.name}`}>
        {shown.map((conversation) => (
          <li key={conversation.id}>
            <button
              type="button"
              className={`sb-row bot-row__thread${conversation.id === props.activeThreadId ? " sb-row--active" : ""}`}
              aria-current={conversation.id === props.activeThreadId ? "true" : undefined}
              onClick={() => props.onSelectConversation?.(conversation.id)}
            >
              <span className="bot-row__thread-dot" aria-hidden="true" />
              <span className="bot-row__thread-title">{conversation.title}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  };

  /**
   * The open Bot's row is the selected row only while none of its listed conversations is open. Once one is, that
   * conversation carries the selection, so two stacked fills do not compete for it.
   */
  const botRowSelected = (bot: DeyinBot): boolean =>
    bot.id === props.activeBotId && !shownConversations(bot).some((conversation) => conversation.id === props.activeThreadId);

  const row = (bot: DeyinBot) => (
    <div key={bot.id} className="bot-row-group">
      <div className={`bot-row${botRowSelected(bot) ? " bot-row--active" : ""}${bot.archived ? " bot-row--archived" : ""}`}>
        <button type="button" className="sb-row bot-row__main" onClick={() => props.onSelect(bot.id)} disabled={bot.archived}>
          <BotAvatar bot={bot} size={26} decorative />
          <span className="bot-row__text">
            <span className="bot-row__name">{bot.name}</span>
            {bot.title ? <span className="bot-row__title">{bot.title}</span> : null}
          </span>
          {bot.isPrimary ? <span className="bot-row__badge">{t("bot.roster.primary")}</span> : null}
          {bot.kind === "room" ? <span className="bot-row__badge">{t("bot.roster.room")}</span> : null}
        </button>
        <AnchoredMenu
          open={menuFor === bot.id}
          onToggle={() => setMenuFor((current) => (current === bot.id ? null : bot.id))}
          onClose={() => setMenuFor((current) => (current === bot.id ? null : current))}
          triggerClassName="sb-icon bot-row__menu"
          triggerAriaLabel={`${t("bot.menu.actions")}: ${bot.name}`}
          trigger={<Icon name="more" size={15} />}
          panelClassName="sb-menu"
          align="end"
        >
          {botMenuActions(bot, props.layout).map((action) => (
            <button
              key={action.kind === "section" ? `section:${action.sectionId}` : action.kind}
              type="button"
              className={`menu__item${action.kind === "delete" ? " menu__item--danger" : ""}`}
              onClick={() => void perform(bot, action)}
            >
              <span className="sb-menu__check">{action.kind === "section" && action.current ? <Icon name="check" size={13} /> : null}</span>
              <span>{action.kind === "section" ? action.name : t(MENU_LABEL[action.kind])}</span>
            </button>
          ))}
        </AnchoredMenu>
      </div>
      {conversationList(bot)}
    </div>
  );

  if (!props.ready) return <div className="bot-roster__status">{t("bot.roster.loading")}</div>;
  if (props.loadError) return <div className="bot-roster__status hint--bad" role="alert">{t("bot.roster.loadError")}</div>;

  const live = props.bots.filter((bot) => !bot.archived);
  const nameForm = editor && (
    <form className="bot-roster__name" onSubmit={(event) => void submitName(event)}>
      <input
        className="input"
        autoFocus
        value={draftName}
        aria-label={t("bot.section.name")}
        placeholder={t("bot.section.name")}
        maxLength={80}
        onChange={(event) => setDraftName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setEditor(null);
        }}
        onBlur={() => {
          if (!draftName.trim()) setEditor(null);
        }}
      />
    </form>
  );

  return (
    <div className="bot-roster">
      {notice ? <div className="bot-roster__notice hint--bad" role="alert">{notice}</div> : null}
      {live.length === 0 && roster.archived.length === 0 ? (
        <div className="bot-roster__empty">
          <strong>{t("bot.roster.empty")}</strong>
          <span>{t("bot.roster.emptyHint")}</span>
        </div>
      ) : null}
      {roster.pinned.length > 0 && (
        <section aria-label={t("bot.roster.pinned")}>
          <div className="sidebar__section">{t("bot.roster.pinned")}</div>
          {roster.pinned.map(row)}
        </section>
      )}
      {nameForm && editor?.mode === "create" ? nameForm : null}
      {roster.groups.map((group) => (
        <section key={group.section?.id ?? "loose"} aria-label={group.section?.name ?? t("bot.roster.title")}>
          {/* The sidebar already says "Bots": the loose group repeats it only when something else needs telling apart from. */}
          {group.section || roster.groups.length > 1 || roster.pinned.length > 0 ? (
            <div className="sidebar__section bot-roster__section">
              <span>{group.section?.name ?? t("bot.roster.title")}</span>
              {group.section ? (
                <span className="bot-roster__section-actions">
                  <button
                    type="button"
                    className="sb-icon"
                    title={t("bot.section.rename")}
                    aria-label={`${t("bot.section.rename")}: ${group.section.name}`}
                    onClick={() => {
                      setDraftName(group.section!.name);
                      setEditor({ mode: "rename", sectionId: group.section!.id, name: group.section!.name });
                    }}
                  >
                    <Icon name="pencil" size={13} />
                  </button>
                  <button
                    type="button"
                    className="sb-icon"
                    title={t("bot.section.remove")}
                    aria-label={`${t("bot.section.remove")}: ${group.section.name}`}
                    onClick={() => void settle(actions.removeSection(group.section!.id))}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}
          {editor?.mode === "rename" && group.section?.id === editor.sectionId ? nameForm : null}
          {group.bots.map(row)}
        </section>
      ))}
      {roster.hidden.length > 0 && (
        <section aria-label={t("bot.roster.hidden")}>
          <button type="button" className="sidebar__section bot-roster__toggle" aria-expanded={showHidden} onClick={() => setShowHidden((v) => !v)}>
            {t("bot.roster.hidden")} ({roster.hidden.length})
          </button>
          {showHidden ? roster.hidden.map(row) : null}
        </section>
      )}
      {props.onNewRoom ? (
        <button type="button" className="sidebar__section bot-roster__toggle" onClick={props.onNewRoom}>
          {t("bot.room.new")}
        </button>
      ) : null}
      {props.onBrowse ? (
        <button type="button" className="sidebar__section bot-roster__toggle" onClick={props.onBrowse}>
          {t("bot.market.discover")}
        </button>
      ) : null}
      {roster.archived.length > 0 && (
        <section aria-label={t("bot.roster.archived")}>
          <button type="button" className="sidebar__section bot-roster__toggle" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
            {t("bot.roster.archived")} ({roster.archived.length})
          </button>
          {showArchived ? roster.archived.map(row) : null}
        </section>
      )}
    </div>
  );
}
