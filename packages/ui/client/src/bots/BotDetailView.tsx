import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { BOT_LIMITS, type DeyinBot } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { BotAvatar } from "../components/BotAvatar.js";
import { useConfirm } from "../components/ConfirmDialog.js";
import { BotAvatarMaker } from "./BotAvatarMaker.js";
import { BotAvatarPicker } from "./BotAvatarPicker.js";
import type { AvatarMakerApi, AvatarModelChoice } from "./botAvatarMaker.js";
import { BotFiles } from "./BotFiles.js";
import { BotMemoryList } from "./BotMemoryList.js";
import { BotPlacement } from "./BotPlacement.js";
import { BotPermissions } from "./BotPermissions.js";
import type { PermissionsApi } from "./botPermissions.js";
import { BotRoomMembers } from "./BotRoomMembers.js";
import { BotRoutines } from "./BotRoutines.js";
import { BotConnections } from "./BotConnections.js";
import { BotShare } from "./BotShare.js";
import { BotSkills } from "./BotSkills.js";
import type { RoutineDefaults, RoutinesApi } from "./botRoutines.js";
import type { BotsApi } from "./botsClient.js";
import type { ServersApi } from "./botServers.js";
import type { SurfacesApi } from "./botSurfaces.js";
import type { FilesApi } from "./botFiles.js";
import type { SkillsApi } from "./botSkills.js";
import type { TeachApi } from "./botTeach.js";
import type { TemplatesApi } from "./botTemplates.js";
import {
  AVATAR_FILE_TYPES,
  followSavedBot,
  formFromBot,
  formProblem,
  formToPatch,
  isFormDirty,
  pickAvatarFile,
  submitBotForm,
  type BotForm,
} from "./botForm.js";

interface BotDetailViewProps {
  /** The Bot to show, or null when it is gone (deleted in another window, say). */
  bot: DeyinBot | null;
  actions: BotsApi;
  /** What a routine needs from the host; absent where automations are unavailable, which hides the section. */
  routines?: { api: RoutinesApi; defaults: RoutineDefaults };
  /** The saved tool permissions; absent where Bots have no host, which hides the section. */
  permissions?: PermissionsApi;
  /** Opens the Vault page; absent where Bots have no Vault, which hides the section. */
  onOpenVault?: () => void;
  /** Where a Bot may run besides this computer; absent where there are no servers, which hides the section. */
  servers?: ServersApi;
  /** Opens the page where servers are set up. */
  onOpenServers?: () => void;
  /** What a Bot knows: its skills, and teaching it by showing; absent where Bots have no host, which hides the section. */
  skills?: { api: SkillsApi; teach?: TeachApi };
  /** A Bot's own files and the library; absent where Bots have no host, which hides the section. */
  files?: FilesApi;
  /** Handing a Bot to someone else as text or a link; absent where Bots have no host, which hides the section. */
  templates?: TemplatesApi;
  /** Ways of reaching a Bot from outside the app (webhook, email, Slack, Teams, X); absent where Bots have no host, which hides the section. */
  connections?: SurfacesApi;
  /** Making an avatar picture from a description, and the image models to make it with; absent where Bots have no host, which hides the button. */
  avatarMaker?: { api: AvatarMakerApi; choices: readonly AvatarModelChoice[] };
  /** Every Bot, so a room's members can be changed from its page; absent, a room's members are shown but not editable. */
  roster?: readonly DeyinBot[];
  onBack: () => void;
  /** The Bot was deleted from this page. */
  onDeleted: (botId: string) => void;
}

export function BotDetailView({ bot, actions, routines, permissions, onOpenVault, servers, onOpenServers, skills, files, templates, connections, avatarMaker, roster, onBack, onDeleted }: BotDetailViewProps) {
  const t = useT();
  if (!bot) {
    return (
      <div className="bot-detail">
        <button type="button" className="btn btn--ghost" onClick={onBack}>
          {t("bot.detail.back")}
        </button>
        <p className="hint" role="status">
          {t("bot.detail.notFound")}
        </p>
      </div>
    );
  }
  // Keyed by id so opening another Bot starts from that Bot's own saved values.
  return <BotDetailEditor key={bot.id} bot={bot} actions={actions} routines={routines} permissions={permissions} onOpenVault={onOpenVault} servers={servers} onOpenServers={onOpenServers} skills={skills} files={files} templates={templates} connections={connections} avatarMaker={avatarMaker} roster={roster} onBack={onBack} onDeleted={onDeleted} />;
}

function BotDetailEditor({ bot, actions, routines, permissions, onOpenVault, servers, onOpenServers, skills, files, templates, connections, avatarMaker, roster, onBack, onDeleted }: Omit<BotDetailViewProps, "bot"> & { bot: DeyinBot }) {
  const t = useT();
  const { confirm } = useConfirm();
  const [form, setForm] = useState<BotForm>(() => formFromBot(bot));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastSeen = useRef(bot);

  // The Bot can change underneath an open form; an untouched form follows it, one with edits keeps them.
  useEffect(() => {
    const previous = lastSeen.current;
    lastSeen.current = bot;
    if (previous !== bot) setForm((current) => followSavedBot(previous, bot, current));
  }, [bot]);

  const isRoom = bot.kind === "room";
  const dirty = isFormDirty(bot, form);
  const problem = dirty ? formProblem(form, "update") : null;
  const edit = (patch: Partial<BotForm>): void => {
    setSaved(false);
    setForm((current) => ({ ...current, ...patch }));
  };

  const save = async (): Promise<void> => {
    if (busy || !dirty || problem) return;
    setBusy(true);
    setError(null);
    const outcome = await submitBotForm(() => actions.update(bot.id, formToPatch(bot, form)));
    setBusy(false);
    if (outcome.kind === "done") {
      setForm(formFromBot(outcome.value));
      setSaved(true);
    } else {
      setError(outcome.error);
    }
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const pick = await pickAvatarFile(file);
    switch (pick.kind) {
      case "ok":
        setError(null);
        edit({ avatarUrl: pick.url });
        return;
      case "rejected":
        setError(pick.why === "type" ? t("bot.detail.avatarBadType") : t("bot.detail.avatarTooBig"));
        return;
      case "unreadable":
        setError(pick.error);
        return;
      default: {
        const unhandled: never = pick;
        throw new Error(`Unhandled avatar pick: ${JSON.stringify(unhandled)}`);
      }
    }
  };

  /** Run an archive, restore or primary change and show a refusal. */
  const manage = async (run: () => ReturnType<BotsApi["archive"]>): Promise<void> => {
    setError(null);
    const outcome = await submitBotForm(run);
    if (outcome.kind === "failed") setError(outcome.error);
  };

  const remove = async (): Promise<void> => {
    const accepted = await confirm({
      title: bot.name,
      message: t("bot.manage.deleteMessage"),
      confirmLabel: t("bot.manage.deleteConfirm"),
      destructive: true,
    });
    if (!accepted) return;
    setError(null);
    const outcome = await submitBotForm(() => actions.delete(bot.id));
    if (outcome.kind === "done") onDeleted(bot.id);
    else setError(outcome.error);
  };

  const text = (id: string, label: string, key: "name" | "title" | "role", max: number) => (
    <div className="field">
      <label className="field__label" htmlFor={`bot-detail-${id}`}>
        {label}
      </label>
      <input id={`bot-detail-${id}`} className="input" value={form[key]} maxLength={max} autoComplete="off" onChange={(event) => edit({ [key]: event.target.value })} />
    </div>
  );

  return (
    <div className="bot-detail">
      <header className="bot-detail__header">
        <button type="button" className="btn btn--ghost" onClick={onBack}>
          {t("bot.detail.back")}
        </button>
        <h2 className="bot-detail__title">{t("bot.detail.title")}</h2>
      </header>
      {bot.archived ? (
        <p className="hint" role="status">
          {t("bot.detail.archived")}
        </p>
      ) : null}

      <form
        className="bot-detail__form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="bot-detail__avatar">
          <BotAvatar bot={{ name: form.name || bot.name, avatarShape: form.avatarShape, avatarColor: form.avatarColor, ...(form.avatarUrl ? { avatarUrl: form.avatarUrl } : {}) }} size={72} decorative />
          <div className="bot-detail__avatar-actions">
            <input ref={fileInput} type="file" hidden accept={AVATAR_FILE_TYPES.join(",")} onChange={(event) => void chooseFile(event)} />
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => fileInput.current?.click()}>
              {t("bot.detail.avatarUpload")}
            </button>
            {form.avatarUrl ? (
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => edit({ avatarUrl: null })}>
                {t("bot.detail.avatarRemove")}
              </button>
            ) : null}
            <span className="hint">{t("bot.detail.avatarHint")}</span>
            {avatarMaker ? (
              <BotAvatarMaker
                api={avatarMaker.api}
                choices={avatarMaker.choices}
                botName={form.name || bot.name}
                disabled={busy}
                onUse={(url) => {
                  setError(null);
                  edit({ avatarUrl: url });
                }}
              />
            ) : null}
          </div>
        </div>
        <BotAvatarPicker
          shape={form.avatarShape}
          color={form.avatarColor}
          name={form.name || bot.name}
          disabled={busy}
          onChange={({ shape, color }) => edit({ avatarShape: shape, avatarColor: color })}
        />

        {text("name", t("bot.detail.name"), "name", BOT_LIMITS.name)}
        {text("label", t("bot.detail.label"), "title", BOT_LIMITS.title)}
        <div className="field">
          <label className="field__label" htmlFor="bot-detail-handle">
            {t("bot.detail.handle")}
          </label>
          <input id="bot-detail-handle" className="input" value={`@${bot.handle}`} readOnly aria-describedby="bot-detail-handle-hint" />
          <span id="bot-detail-handle-hint" className="hint">
            {t("bot.detail.handleHint")}
          </span>
        </div>
        {isRoom ? null : text("role", t("bot.detail.role"), "role", BOT_LIMITS.role)}
        <div className="field">
          <label className="field__label" htmlFor="bot-detail-description">
            {t("bot.detail.description")}
          </label>
          <textarea id="bot-detail-description" className="input" rows={3} value={form.description} maxLength={BOT_LIMITS.description} onChange={(event) => edit({ description: event.target.value })} />
        </div>
        {isRoom ? null : (
          <div className="field">
            <label className="field__label" htmlFor="bot-detail-purpose">
              {t("bot.detail.purpose")}
            </label>
            <textarea
              id="bot-detail-purpose"
              className="input"
              rows={6}
              value={form.purpose}
              maxLength={BOT_LIMITS.purpose}
              aria-describedby="bot-detail-purpose-hint"
              onChange={(event) => edit({ purpose: event.target.value })}
            />
            <span id="bot-detail-purpose-hint" className="hint">
              {t("bot.detail.purposeHint")}
            </span>
          </div>
        )}

        <p className="hint--bad" role="alert" hidden={!error && !problem}>
          {error ?? problem}
        </p>
        <div className="bot-detail__save">
          <button type="submit" className="btn btn--primary" disabled={busy || !dirty || problem !== null}>
            {busy ? t("bot.detail.saving") : t("bot.detail.save")}
          </button>
          <span className="hint" role="status">
            {saved && !dirty ? t("bot.detail.saved") : ""}
          </span>
        </div>
      </form>

      {isRoom && roster ? <BotRoomMembers room={bot} bots={roster} actions={actions} /> : null}

      {servers && !isRoom ? <BotPlacement bot={bot} actions={actions} api={servers} onOpenServers={onOpenServers} /> : null}

      <BotMemoryList botId={bot.id} actions={actions} />

      {permissions ? <BotPermissions bot={bot} actions={actions} api={permissions} /> : null}

      {onOpenVault ? (
        <section className="bot-vault-link" aria-label={t("bot.detail.vault")}>
          <h3 className="bot-detail__heading">{t("bot.detail.vault")}</h3>
          <p className="hint">{t("bot.detail.vaultHint")}</p>
          <div>
            <button type="button" className="btn btn--outline" onClick={onOpenVault}>
              {t("bot.detail.openVault")}
            </button>
          </div>
        </section>
      ) : null}

      {routines && !isRoom ? <BotRoutines bot={bot} api={routines.api} defaults={routines.defaults} /> : null}

      {connections && routines && !isRoom ? <BotConnections bot={bot} api={connections} routines={routines} /> : null}

      {skills && !isRoom ? <BotSkills bot={bot} api={skills.api} teach={skills.teach} /> : null}

      {files ? <BotFiles bot={bot} api={files} /> : null}

      {templates && !isRoom ? <BotShare bot={bot} api={templates} /> : null}

      <section className="bot-detail__manage" aria-label={t("bot.manage.title")}>
        <h3 className="bot-detail__heading">{t("bot.manage.title")}</h3>
        <p className="hint">{t("bot.manage.archiveHint")}</p>
        <div className="bot-detail__manage-actions">
          {!bot.archived && !bot.isPrimary ? (
            <button type="button" className="btn btn--ghost" onClick={() => void manage(() => actions.setPrimary(bot.id))}>
              {t("bot.menu.makePrimary")}
            </button>
          ) : null}
          <button type="button" className="btn btn--ghost" onClick={() => void manage(() => (bot.archived ? actions.restore(bot.id) : actions.archive(bot.id)))}>
            {bot.archived ? t("bot.menu.restore") : t("bot.menu.archive")}
          </button>
          <button type="button" className="btn btn--ghost btn--danger" onClick={() => void remove()}>
            {t("bot.manage.delete")}
          </button>
        </div>
      </section>
    </div>
  );
}
