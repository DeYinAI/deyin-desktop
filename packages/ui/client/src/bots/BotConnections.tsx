import { useMemo, useSyncExternalStore } from "react";
import { SURFACE_KINDS, SURFACE_LIMITS, type DeyinBot } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { useConfirm } from "../components/ConfirmDialog.js";
import { createConnectionsController, type ConnectionsController, type ConnectionsState } from "./botConnectionsController.js";
import type { RoutineDefaults, RoutinesApi } from "./botRoutines.js";
import {
  activityRows,
  fieldLabelKey,
  hubFormFrom,
  isFieldName,
  kindLabelKey,
  messageRoutineBlock,
  outboxRows,
  routineChoices,
  surfaceStatus,
  type SurfacesApi,
} from "./botSurfaces.js";
import { SurfaceActivityList } from "./SurfaceActivityList.js";
import { SurfaceCard, type RoutineMaker } from "./SurfaceCard.js";
import { SurfaceHub } from "./SurfaceHub.js";
import { SurfaceOutbox } from "./SurfaceOutbox.js";

interface BotConnectionsProps {
  bot: DeyinBot;
  api: SurfacesApi;
  /** The routines a connection hands messages to, and what a new one is run with. */
  routines: { api: RoutinesApi; defaults: RoutineDefaults };
}

/** The Connections section of a Bot: how it can be reached from outside, who may, and what is waiting for approval. */
export function BotConnections({ bot, api, routines }: BotConnectionsProps) {
  const controller = useMemo(() => createConnectionsController({ botId: bot.id, api, routines: routines.api }), [bot.id, api, routines.api]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  return <BotConnectionsPanel bot={bot} state={state} controller={controller} defaults={routines.defaults} />;
}

interface PanelProps {
  bot: Pick<DeyinBot, "id" | "archived">;
  state: ConnectionsState;
  controller: ConnectionsController;
  defaults: RoutineDefaults;
}

/** The section drawn from a state and a controller, so every state of it can be rendered without a host. */
export function BotConnectionsPanel({ bot, state, controller, defaults }: PanelProps) {
  const t = useT();
  const { confirm } = useConfirm();
  const { load } = state;
  const ready = load.status === "ready" ? load.state : null;
  const automations = state.automations ?? [];
  const choices = routineChoices(automations, bot.id);
  const routineMaker: RoutineMaker = messageRoutineBlock(automations, bot, defaults) ?? "ok";

  const askRemove = async (kind: (typeof SURFACE_KINDS)[number]): Promise<void> => {
    const accepted = await confirm({
      title: t(kindLabelKey(kind)),
      message: fill(t("bot.conn.removeMessage"), { kind: t(kindLabelKey(kind)) }),
      confirmLabel: t("bot.conn.remove"),
      destructive: true,
    });
    if (accepted) await controller.remove(kind);
  };

  const askRemake = async (kind: (typeof SURFACE_KINDS)[number], name: string): Promise<void> => {
    const label = isFieldName(name) ? t(fieldLabelKey(name)) : name;
    const accepted = await confirm({
      title: fill(t("bot.conn.generated.make"), { name: label }),
      message: t("bot.conn.generated.makeMessage"),
      confirmLabel: fill(t("bot.conn.generated.make"), { name: label }),
      destructive: true,
    });
    if (accepted) await controller.remake(kind, name);
  };

  const hasX = ready?.surfaces.some((surface) => surface.surface === "x") ?? false;
  const rows = ready ? outboxRows(ready.outbox, state.edits, SURFACE_LIMITS.xChars) : { waiting: [], earlier: [] };

  return (
    <section className="bot-panel conn-panel" aria-label={t("bot.conn.title")}>
      <h3 className="bot-detail__heading">{t("bot.conn.title")}</h3>
      <p className="hint">{t("bot.conn.hint")}</p>
      {state.notice ? (
        <p className="hint--bad" role="alert">
          {state.notice}
        </p>
      ) : null}
      {load.status === "loading" ? (
        <p className="hint" role="status">
          {t("bot.conn.loading")}
        </p>
      ) : null}
      {load.status === "error" ? (
        <p className="hint--bad" role="alert">
          {t("bot.conn.loadError")} {load.error}
        </p>
      ) : null}
      {ready ? (
        <>
          {ready.protection === "file-permissions" ? <p className="hint">{t("bot.conn.protectionWeak")}</p> : null}
          <ul className="bot-panel__list">
            {SURFACE_KINDS.map((kind) => {
              const view = ready.surfaces.find((surface) => surface.surface === kind);
              const cardState = state.cards[kind];
              return (
                <SurfaceCard
                  key={kind}
                  kind={kind}
                  botId={bot.id}
                  view={view}
                  status={surfaceStatus(kind, view, ready.hub.status)}
                  hub={ready.hub.settings}
                  routines={choices}
                  form={state.forms[kind] ?? null}
                  busy={cardState?.busy ?? false}
                  error={cardState?.error ?? null}
                  saved={cardState?.saved ?? false}
                  generated={state.generated[kind] ?? {}}
                  routineMaker={routineMaker}
                  makingRoutine={cardState?.making ?? false}
                  onOpen={() => controller.open(kind)}
                  onClose={() => controller.close(kind)}
                  onChange={(patch) => controller.change(kind, patch)}
                  onSave={() => void controller.save(kind)}
                  onToggle={(enabled) => void controller.toggle(kind, enabled)}
                  onRemove={() => void askRemove(kind)}
                  onRemake={(name) => void askRemake(kind, name)}
                  onMakeRoutine={() => void controller.makeRoutine(kind, t("bot.conn.routine.name"), defaults)}
                  onDismissGenerated={(name) => controller.dismissGenerated(kind, name)}
                />
              );
            })}
          </ul>
          {hasX || rows.waiting.length > 0 || rows.earlier.length > 0 ? (
            <SurfaceOutbox
              waiting={rows.waiting}
              earlier={rows.earlier}
              busyId={state.outbox.busyId}
              errors={state.outbox.errors}
              onEdit={(id, text) => controller.editPost(id, text)}
              onApprove={(row) => void controller.approve(row.post)}
              onDeny={(id) => void controller.deny(id)}
            />
          ) : null}
          <SurfaceHub
            settings={ready.hub.settings}
            status={ready.hub.status}
            form={state.hub.form ?? hubFormFrom(ready.hub.settings)}
            busy={state.hub.busy}
            error={state.hub.error}
            saved={state.hub.saved}
            onChange={(patch) => controller.changeHub(patch)}
            onSave={() => void controller.saveHub()}
            onRetry={() => void controller.retryHub()}
          />
          <SurfaceActivityList rows={activityRows(ready.activity)} />
        </>
      ) : null}
    </section>
  );
}
