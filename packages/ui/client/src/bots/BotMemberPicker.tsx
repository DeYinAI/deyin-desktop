import { BOT_LIMITS } from "@deyin/host-core/shared";
import { fill } from "../automationFormat.js";
import { useT } from "../i18n.js";
import { BotAvatar } from "../components/BotAvatar.js";
import type { MemberRow } from "./botRoom.js";

interface BotMemberPickerProps {
  rows: readonly MemberRow[];
  /** Whether the room already holds as many Bots as it may; the ones not chosen can no longer be added. */
  full: boolean;
  disabled?: boolean;
  onToggle: (botId: string) => void;
}

/** The Bots to put in a room: a checkbox for each, with its handle, so it is clear what @ will reach. */
export function BotMemberPicker({ rows, full, disabled = false, onToggle }: BotMemberPickerProps) {
  const t = useT();
  return (
    <fieldset className="bot-members" disabled={disabled}>
      <legend className="field__label">{t("bot.room.members")}</legend>
      <ul className="bot-members__list">
        {rows.map(({ bot, selected, unavailable }) => (
          <li key={bot.id}>
            <label className={`bot-member${selected ? " bot-member--on" : ""}`}>
              <input type="checkbox" checked={selected} disabled={!selected && full} onChange={() => onToggle(bot.id)} />
              <BotAvatar bot={bot} size={22} decorative />
              <span className="bot-member__name">{bot.name}</span>
              <span className="bot-member__handle">@{bot.handle}</span>
              {unavailable ? <span className="bot-row__badge">{t("bot.room.archived")}</span> : null}
            </label>
          </li>
        ))}
      </ul>
      {full ? <p className="hint">{fill(t("bot.room.full"), { limit: BOT_LIMITS.maxRoomMembers })}</p> : null}
    </fieldset>
  );
}
