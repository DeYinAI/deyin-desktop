import {
  BotError,
  botResult,
  botResultAsync,
  isPostId,
  isSurfaceKind,
  readXPostResult,
  xPostRequest,
  type ActivityLog,
  type BotResult,
  type BotSurfacesState,
  type DeyinBot,
  type HttpFetch,
  type HubSettings,
  type HubStatus,
  type Outbox,
  type OutboxPost,
  type SurfaceKind,
  type SurfaceSaved,
  type SurfaceStore,
  type SurfaceView,
} from "@deyin/host-core";

export interface SurfaceHandlerDeps {
  bots: { get(id: string): DeyinBot | undefined };
  store: Pick<SurfaceStore, "list" | "get" | "save" | "remake" | "setEnabled" | "remove" | "secret" | "protection" | "hubSettings" | "setHubSettings">;
  outbox: Pick<Outbox, "list" | "edit" | "claim" | "sent" | "failed" | "deny">;
  activity: Pick<ActivityLog, "recent">;
  /** A Bot's routines, so a surface can only be pointed at one that is the Bot's own. */
  routines: { get(routineId: string): { id: string; botId?: string } | undefined };
  hub: { status(): HubStatus; start(port: number): Promise<HubStatus> };
  fetch: HttpFetch;
}

export interface SurfaceHandlers {
  state(botId: unknown): BotResult<BotSurfacesState>;
  save(botId: unknown, kind: unknown, input: unknown): BotResult<SurfaceSaved>;
  remake(botId: unknown, kind: unknown, name: unknown): BotResult<{ view: SurfaceView; value: string }>;
  setEnabled(botId: unknown, kind: unknown, enabled: unknown): BotResult<SurfaceView>;
  remove(botId: unknown, kind: unknown): BotResult<null>;
  setHub(settings: unknown): Promise<BotResult<{ settings: HubSettings; status: HubStatus }>>;
  outboxEdit(id: unknown, text: unknown): BotResult<OutboxPost>;
  outboxApprove(id: unknown): Promise<BotResult<OutboxPost>>;
  outboxDeny(id: unknown): BotResult<OutboxPost>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new BotError("invalid", `${what} is required.`);
  return value;
}

function kindOf(value: unknown): SurfaceKind {
  if (!isSurfaceKind(value)) throw new BotError("invalid", "That is not somewhere a Bot can be reached.");
  return value;
}

/**
 * The Connections panel's calls. Everything arrives from the renderer, so it is checked here: the Bot has to exist, the
 * routine has to be that Bot's own, and no call returns a secret. Approving a post is the only thing here that reaches
 * out to a service, and it posts the words the draft holds at that moment, once.
 */
export function createSurfaceHandlers(deps: SurfaceHandlerDeps): SurfaceHandlers {
  const bot = (value: unknown): string => {
    const id = text(value, "The Bot");
    const found = deps.bots.get(id);
    if (!found) throw new BotError("not_found", "That Bot is not here any more.");
    if (found.kind === "room") throw new BotError("invalid", `${found.name} is a room. Connect one of its Bots instead.`);
    return id;
  };

  const ownRoutine = (botId: string, input: unknown): void => {
    const routineId = typeof input === "object" && input !== null ? (input as { routineId?: unknown }).routineId : undefined;
    if (routineId === undefined || routineId === "") return;
    if (typeof routineId !== "string") throw new BotError("invalid", "The routine must be chosen from the list.");
    const routine = deps.routines.get(routineId);
    if (!routine || routine.botId !== botId) throw new BotError("invalid", "That routine is not one of this Bot's.");
  };

  return {
    state: (botId) =>
      botResult(() => {
        const id = bot(botId);
        return {
          surfaces: deps.store.list(id),
          hub: { settings: deps.store.hubSettings(), status: deps.hub.status() },
          activity: deps.activity.recent(id),
          outbox: deps.outbox.list(id),
          protection: deps.store.protection(),
        };
      }),
    save: (botId, kind, input) =>
      botResult(() => {
        const id = bot(botId);
        const surface = kindOf(kind);
        ownRoutine(id, input);
        return deps.store.save(id, surface, input);
      }),
    remake: (botId, kind, name) =>
      botResult(() => {
        const id = bot(botId);
        return deps.store.remake(id, kindOf(kind), text(name, "The key"));
      }),
    setEnabled: (botId, kind, enabled) =>
      botResult(() => {
        const id = bot(botId);
        if (typeof enabled !== "boolean") throw new BotError("invalid", "Say whether it is on or off.");
        return deps.store.setEnabled(id, kindOf(kind), enabled);
      }),
    remove: (botId, kind) =>
      botResult(() => {
        deps.store.remove(bot(botId), kindOf(kind));
        return null;
      }),
    setHub: (input) =>
      botResultAsync(async () => {
        const before = deps.store.hubSettings();
        const settings = deps.store.setHubSettings(input);
        // A new port means listening again; a new public address only changes what is shown.
        const status = settings.port !== before.port || !deps.hub.status().listening ? await deps.hub.start(settings.port) : deps.hub.status();
        return { settings, status };
      }),
    outboxEdit: (id, words) =>
      botResult(() => {
        if (typeof words !== "string") throw new BotError("invalid", "A post needs some words.");
        return deps.outbox.edit(text(id, "The post"), words);
      }),
    outboxDeny: (id) => botResult(() => deps.outbox.deny(text(id, "The post"))),
    outboxApprove: (id) =>
      botResultAsync(async () => {
        const postId = text(id, "The post");
        const draft = deps.outbox.list().find((candidate) => candidate.id === postId);
        if (!draft) throw new BotError("not_found", "That post is not in the Outbox any more.");
        // Everything that can be known before the draft is taken is checked first, so a refusal leaves it waiting.
        const surface = deps.store.get(draft.botId, "x");
        const token = deps.store.secret(draft.botId, "x", "accessToken");
        if (!surface || !token) throw new BotError("invalid", "X is not connected for this Bot. Connect it first.");
        if (!surface.enabled) throw new BotError("invalid", "X is switched off for this Bot. Switch it on to post.");
        if (!isPostId(draft.inReplyTo)) throw new BotError("invalid", "The post this answers has an id X would not recognise.");
        const claimed = deps.outbox.claim(postId);
        try {
          const call = xPostRequest(token, claimed.text, claimed.inReplyTo);
          const response = await deps.fetch(call.url, call.init);
          let body: unknown = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          const result = readXPostResult(response.status, body);
          if (result.ok) deps.outbox.sent(postId, result.url);
          else deps.outbox.failed(postId, result.error);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.outbox.failed(postId, `The post could not be sent: ${message.split(token).join("•••")}`);
        }
        const done = deps.outbox.list().find((candidate) => candidate.id === postId);
        if (!done) throw new BotError("not_found", "That post is not in the Outbox any more.");
        return done;
      }),
  };
}
