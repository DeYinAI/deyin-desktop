import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES, type BotAvatarColor, type BotAvatarShape } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { BotAvatar } from "../components/BotAvatar.js";

interface BotAvatarPickerProps {
  shape: BotAvatarShape;
  color: BotAvatarColor;
  /** The Bot's name, so each preview is drawn the way this Bot's own avatar would be. */
  name: string;
  disabled?: boolean;
  onChange: (next: { shape: BotAvatarShape; color: BotAvatarColor }) => void;
}

/** Shape and color choices for a Bot's avatar, as two radio groups. */
export function BotAvatarPicker({ shape, color, name, disabled, onChange }: BotAvatarPickerProps) {
  const t = useT();
  return (
    <div className="bot-picker">
      <div role="radiogroup" aria-label={t("bot.create.shape")} className="bot-picker__shapes">
        {BOT_AVATAR_SHAPES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === shape}
            aria-label={option}
            title={option}
            disabled={disabled}
            className={`bot-picker__shape${option === shape ? " bot-picker__shape--on" : ""}`}
            onClick={() => onChange({ shape: option, color })}
          >
            <BotAvatar bot={{ name, avatarShape: option, avatarColor: color }} size={34} decorative />
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label={t("bot.create.color")} className="bot-picker__colors">
        {BOT_AVATAR_COLORS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={option.id === color}
            aria-label={option.label}
            title={option.label}
            disabled={disabled}
            className={`bot-picker__color${option.id === color ? " bot-picker__color--on" : ""}`}
            style={{ background: option.value }}
            onClick={() => onChange({ shape, color: option.id })}
          />
        ))}
      </div>
    </div>
  );
}
