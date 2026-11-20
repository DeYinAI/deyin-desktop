import { useEffect, useRef, useState } from "react";
import { BOT_LIMITS, type DeyinBot } from "@deyin/host-core/shared";
import { fill } from "../automationFormat.js";
import { useT } from "../i18n.js";
import { BotMemberPicker } from "./BotMemberPicker.js";
import { submitBotForm } from "./botForm.js";
import { followSavedMembers, memberRows, membersPatch, roomIsFull, roomProblem, toggleMember } from "./botRoom.js";
import type { BotsApi } from "./botsClient.js";

interface BotRoomMembersProps {
  room: DeyinBot;
  /** Every Bot, so the active ones can be offered. */
  bots: readonly DeyinBot[];
  actions: BotsApi;
}

/** A room's page section for changing who is in it. */
export function BotRoomMembers({ room, bots, actions }: BotRoomMembersProps) {
  const t = useT();
  const [chosen, setChosen] = useState<string[]>(() => [...room.memberBotIds]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const lastSeen = useRef(room);

  // The room can change underneath the picker; an untouched picker follows it, one with edits keeps them.
  useEffect(() => {
    const previous = lastSeen.current;
    lastSeen.current = room;
    if (previous !== room) setChosen((current) => followSavedMembers(previous, room, current));
  }, [room]);

  const patch = membersPatch(room, chosen);
  const short = patch !== null && roomProblem(room.name, chosen, bots) === "members";

  const save = async (): Promise<void> => {
    if (busy || !patch || short) return;
    setBusy(true);
    setError(null);
    const outcome = await submitBotForm(() => actions.update(room.id, patch));
    setBusy(false);
    if (outcome.kind === "done") {
      setChosen([...outcome.value.memberBotIds]);
      setSaved(true);
    } else {
      setError(outcome.error);
    }
  };

  return (
    <section className="bot-room-members" aria-label={t("bot.room.membersTitle")}>
      <h3 className="bot-detail__heading">{t("bot.room.membersTitle")}</h3>
      <BotMemberPicker
        rows={memberRows(bots, chosen)}
        full={roomIsFull(chosen)}
        disabled={busy}
        onToggle={(id) => {
          setSaved(false);
          setChosen((current) => toggleMember(current, id));
        }}
      />
      <p className="hint">{t("bot.room.membersHint")}</p>
      <p className="hint--bad" role="alert" hidden={!error && !short}>
        {error ?? fill(t("bot.room.needMembers"), { min: BOT_LIMITS.minRoomMembers })}
      </p>
      <div className="bot-detail__save">
        <button type="button" className="btn btn--primary" disabled={busy || !patch || short} onClick={() => void save()}>
          {busy ? t("bot.room.saving") : t("bot.room.save")}
        </button>
        <span className="hint" role="status">
          {saved && !patch ? t("bot.room.saved") : ""}
        </span>
      </div>
    </section>
  );
}
