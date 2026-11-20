import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n.js";
import { writeClipboardText } from "../clipboard.js";
import { Icon } from "./Icon.js";

/** Glyph size; fills the 16px content box of the 28px hit target (see styles.css). */
const ACTION_ICON_SIZE = 16;

export interface MessageActionsProps {
  /** Text the copy action writes; omit to hide Copy. */
  text?: string | null;
  /** Rating recorded for this message; omitted hides Like/Dislike. */
  feedback?: "up" | "down" | null;
  /** Reports the clicked rating — the owner retracts when it repeats the current one. */
  onFeedback?: (rating: "up" | "down") => void;
  /** Edit affordance under a user bubble; omitted hides it. */
  onEdit?: () => void;
  /** Fork the chat at this message; omitted hides Branch. */
  onFork?: () => void;
  /** Why Branch cannot run here — keeps the control visible, dimmed, and explained. */
  forkUnavailableReason?: string;
  /** Extra row classes for placement in the owning message. */
  className?: string;
}

/**
 * Message action row shared by user and assistant bubbles: copy, like/dislike,
 * edit, and branch — the same set the DeepSeek harness puts under an answer.
 * Icons stay visible at rest (muted, readable on every theme) and brighten on
 * hover, so the row reads as part of the message instead of appearing only
 * under the pointer.
 */
export function MessageActions({
  text,
  feedback,
  onFeedback,
  onEdit,
  onFork,
  forkUnavailableReason,
  className,
}: MessageActionsProps) {
  const t = useT();
  const copyText = (text ?? "").trim();
  const [copied, setCopied] = useState(false);
  // A copy in flight must not re-write the clipboard or stack reset timers.
  const copyPending = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyEpoch = useRef(0);

  useEffect(
    () => () => {
      copyEpoch.current += 1;
      copyPending.current = false;
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = useCallback(() => {
    if (copied || copyPending.current || !copyText) return;
    const epoch = copyEpoch.current;
    copyPending.current = true;
    void writeClipboardText(copyText).then((ok) => {
      if (epoch !== copyEpoch.current) return;
      copyPending.current = false;
      if (!ok) return;
      setCopied(true);
      copyTimer.current = setTimeout(() => {
        copyTimer.current = null;
        setCopied(false);
      }, 1000);
    });
  }, [copied, copyText]);

  const forkDisabled = onFork !== undefined && forkUnavailableReason !== undefined;
  const upActive = feedback === "up";
  const downActive = feedback === "down";
  const copyLabel = copied ? t("chat.copied") : t("chat.copyMessage");
  const likeLabel = t(upActive ? "chat.feedbackUpActive" : "chat.feedbackUp");
  const dislikeLabel = t(downActive ? "chat.feedbackDownActive" : "chat.feedbackDown");
  const forkLabel = forkDisabled ? forkUnavailableReason : t("chat.forkHere");

  return (
    <div className={className ? `message-actions ${className}` : "message-actions"}>
      {copyText.length > 0 && (
        <button
          type="button"
          className="message-actions__action"
          onClick={copy}
          title={copyLabel}
          aria-label={copyLabel}
        >
          <Icon name={copied ? "check" : "copy"} size={ACTION_ICON_SIZE} />
        </button>
      )}
      {onFeedback && (
        <>
          <button
            type="button"
            className={`message-actions__action${upActive ? " message-actions__action--active" : ""}`}
            onClick={() => onFeedback("up")}
            title={likeLabel}
            aria-label={likeLabel}
            aria-pressed={upActive}
          >
            <Icon name="thumbUp" size={ACTION_ICON_SIZE} />
          </button>
          <button
            type="button"
            className={`message-actions__action${downActive ? " message-actions__action--active" : ""}`}
            onClick={() => onFeedback("down")}
            title={dislikeLabel}
            aria-label={dislikeLabel}
            aria-pressed={downActive}
          >
            <Icon name="thumbDown" size={ACTION_ICON_SIZE} />
          </button>
        </>
      )}
      {onEdit && (
        <button
          type="button"
          className="message-actions__action"
          onClick={onEdit}
          title={t("chat.editMessage")}
          aria-label={t("chat.editMessage")}
        >
          <Icon name="pencil" size={ACTION_ICON_SIZE} />
        </button>
      )}
      {onFork && (
        <button
          type="button"
          className="message-actions__action"
          // A natively disabled button stops delivering hover/focus, which is
          // what carries the explanation; keep it focusable and inert instead.
          aria-disabled={forkDisabled ? true : undefined}
          data-unavailable={forkDisabled ? true : undefined}
          onClick={forkDisabled ? undefined : onFork}
          title={forkLabel}
          aria-label={t("chat.forkHere")}
        >
          <Icon name="gitBranch" size={ACTION_ICON_SIZE} />
        </button>
      )}
    </div>
  );
}
