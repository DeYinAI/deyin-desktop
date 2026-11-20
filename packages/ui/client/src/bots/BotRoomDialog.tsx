import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BotInput, BotResult, DeyinBot } from "@deyin/contract";
import { BOT_LIMITS, type MessageKey } from "@deyin/host-core/shared";
import { fill } from "../automationFormat.js";
import { useT } from "../i18n.js";
import { BotMemberPicker } from "./BotMemberPicker.js";
import { submitBotForm } from "./botForm.js";
import { memberRows, newRoomForm, roomFormToInput, roomIsFull, roomProblem, toggleMember, type RoomForm, type RoomProblem } from "./botRoom.js";

interface BotRoomDialogProps {
  /** Every Bot, so the active ones can be offered as members. */
  bots: readonly DeyinBot[];
  /** Creates the room; the dialog closes only when this resolves with success. */
  onCreate: (input: BotInput) => Promise<BotResult<DeyinBot>>;
  onCreated: (room: DeyinBot) => void;
  onCancel: () => void;
}

const PROBLEM_KEY: Record<RoomProblem, MessageKey> = {
  name: "bot.room.needName",
  members: "bot.room.needMembers",
};

/** The "New room" dialog: a name and the Bots that will be in it. */
export function BotRoomDialog({ bots, onCreate, onCreated, onCancel }: BotRoomDialogProps) {
  const t = useT();
  const [form, setForm] = useState<RoomForm>(newRoomForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const rows = memberRows(bots, form.memberIds);
  const problem = roomProblem(form.name, form.memberIds, bots);
  const tooFew = rows.length < BOT_LIMITS.minRoomMembers;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || problem) return;
    setBusy(true);
    setError(null);
    const outcome = await submitBotForm(() => onCreate(roomFormToInput(form)));
    setBusy(false);
    if (outcome.kind === "done") onCreated(outcome.value);
    else setError(outcome.error);
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bot-room-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <form className="modal bot-create bot-room" onSubmit={(event) => void submit(event)}>
        <h2 id="bot-room-title" className="bot-create__title">
          {t("bot.room.title")}
        </h2>
        <div className="field">
          <label className="field__label" htmlFor="bot-room-name">
            {t("bot.room.name")}
          </label>
          <input
            id="bot-room-name"
            ref={nameRef}
            className="input"
            value={form.name}
            placeholder={t("bot.room.namePlaceholder")}
            disabled={busy}
            maxLength={BOT_LIMITS.name}
            autoComplete="off"
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </div>
        {tooFew ? (
          <p className="hint" role="status">
            {fill(t("bot.room.tooFew"), { min: BOT_LIMITS.minRoomMembers })}
          </p>
        ) : (
          <>
            <BotMemberPicker rows={rows} full={roomIsFull(form.memberIds)} disabled={busy} onToggle={(id) => setForm({ ...form, memberIds: toggleMember(form.memberIds, id) })} />
            <p className="hint">{t("bot.room.membersHint")}</p>
          </>
        )}
        <p className="bot-create__error hint--bad" role="alert" hidden={!error}>
          {error}
        </p>
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onCancel}>
            {t("bot.create.cancel")}
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || problem !== null}
            title={problem ? fill(t(PROBLEM_KEY[problem]), { min: BOT_LIMITS.minRoomMembers }) : undefined}
          >
            {busy ? t("bot.room.creating") : t("bot.room.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
