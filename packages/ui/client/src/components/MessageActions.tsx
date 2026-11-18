import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";

/** Writes text and resolves false when the host refuses clipboard access. */
async function writeClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Denied permissions or iframe policy must not claim a copy that failed.
    return false;
  }
}

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
 * Icons stay visible at rest (muted) and brighten on hover, so the row reads as
 * part of the message instead of appearing only under the pointer.
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
    void writeClipboard(copyText).then((ok) => {
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
          <Icon name={copied ? "check" : "copy"} size={14} />
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
            <Icon name="thumbUp" size={14} />
          </button>
          <button
            type="button"
            className={`message-actions__action${downActive ? " message-actions__action--active" : ""}`}
            onClick={() => onFeedback("down")}
            title={dislikeLabel}
            aria-label={dislikeLabel}
            aria-pressed={downActive}
          >
            <Icon name="thumbDown" size={14} />
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
          <Icon name="pencil" size={14} />
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
          <Icon name="gitBranch" size={14} />
        </button>
      )}
    </div>
  );
}
