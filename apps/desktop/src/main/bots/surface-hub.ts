import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ConversationLog,
  DeliveryDedupe,
  RateWindow,
  SURFACE_LIMITS,
  conversationId,
  fitReply,
  inboundPrompt,
  isAllowed,
  parseEmailDelivery,
  parseSlackEvent,
  parseTeamsActivity,
  presentedKey,
  safeEqual,
  slackReplyFailure,
  slackReplyRequest,
  headerOf,
  teamsReplyActivity,
  teamsReplyUrl,
  tokenKeyId,
  verifyBodySignature,
  verifyBotFrameworkToken,
  verifySlackSignature,
  type ActivityLog,
  type BotFrameworkKeys,
  type BotFrameworkTokens,
  type HttpFetch,
  type HubStatus,
  type InboundMessage,
  type SurfaceKind,
  type SurfaceStore,
  type SurfaceView,
  type TeamsTarget,
} from "@deyin/host-core";
import { RoutineBusyError } from "../automations/runner.js";
import type { RunEnd } from "./run-watch.js";

/** One request to the hub, whatever carried it. */
export interface HubRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Buffer;
}

export interface HubResponse {
  status: number;
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
}

/** The surfaces that call the hub. X does not call: it is asked, in `surface-x-poller`. */
type CallingSurface = Exclude<SurfaceKind, "x">;

export interface SurfaceHubDeps {
  store: Pick<SurfaceStore, "get" | "secret" | "hubSettings">;
  /** The routines there are, so a message is only handed to one that exists, belongs to the Bot and is on. */
  routines: { get(routineId: string): { id: string; botId?: string; enabled: boolean } | undefined };
  /** Hand a message to a routine: the run it starts. Throws `RoutineBusyError` when the routine will not take another. */
  invoke(routineId: string, text: string): { id: string };
  /** Resolves when a run is over. */
  settled(runId: string): Promise<RunEnd>;
  fetch: HttpFetch;
  keys: Pick<BotFrameworkKeys, "keysFor">;
  tokens: Pick<BotFrameworkTokens, "get">;
  activity: ActivityLog;
  /** Where an unexpected failure is written, for the owner. */
  log?: (message: string) => void;
  now?: () => number;
}

const NOT_FOUND: HubResponse = { status: 404, body: "not found", contentType: "text/plain" };
const FAILED_REPLY = "Sorry, I could not do that just now.";
const ROUTE = /^\/hooks\/(webhook|email|slack|teams)\/([^/]+)$/;

const reply = (status: number, body: unknown): HubResponse => ({ status, body: JSON.stringify(body), contentType: "application/json" });
const ack = (): HubResponse => reply(200, {});

/** Take secrets out of a message about a failure before it is kept anywhere. */
function redact(message: string, secrets: readonly (string | null)[]): string {
  let clean = message;
  for (const secret of secrets) if (secret && secret.length >= 4) clean = clean.split(secret).join("•••");
  return clean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How the Bot's words go back where the message came from, or null when this surface has no way back. A string is why it failed. */
type Sender = (text: string) => Promise<string | null>;

/**
 * The one place the outside reaches a Bot. It listens on this computer only; whatever lets a service reach it (a tunnel,
 * a proxy) is the owner's to set up. Every request has to prove itself first, with a key or a signature the service
 * makes with a secret only the owner and the service hold; after that the sender must be on the Bot's list, the routine
 * must be on, and the Bot may be asked no more than so often. A refused request says as little as it can.
 */
export class SurfaceHub {
  private readonly conversations = new ConversationLog();
  private readonly dedupe: DeliveryDedupe;
  private readonly rate: RateWindow;
  private readonly background = new Set<Promise<void>>();
  private server: Server | null = null;
  private port = 0;
  private error: string | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: SurfaceHubDeps) {
    this.now = deps.now ?? Date.now;
    this.dedupe = new DeliveryDedupe(this.now);
    this.rate = new RateWindow(this.now);
  }

  /* The listening side ----------------------------------------------------------- */

  status(): HubStatus {
    return { listening: this.server?.listening === true, port: this.port, ...(this.error ? { error: this.error } : {}) };
  }

  /** Start listening on this computer only. Resolves with the status either way: a port in use is something to show, not to throw. */
  async start(port: number): Promise<HubStatus> {
    await this.stop();
    this.port = port;
    this.error = undefined;
    const server = createServer((request, response) => void this.serve(request, response));
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 2_000;
    server.maxHeadersCount = 50;
    this.server = server;
    await new Promise<void>((resolve) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        this.error = error.code === "EADDRINUSE" ? `Port ${port} is already in use. Pick another one.` : `Could not listen on port ${port}: ${error.message}`;
        this.server = null;
        resolve();
      });
      server.listen(port, "127.0.0.1", () => {
        // Asking for port 0 lets the system choose; the status says which it was.
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
    return this.status();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Replies still waiting on a run are left to finish: they need no open port, and a run can take a long time.
  }

  /** Resolves when every reply that is being waited for has been sent or has failed. */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /** Forget what is kept about a Bot's conversations. */
  forgetBot(botId: string): void {
    this.conversations.forgetBot(botId);
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > SURFACE_LIMITS.bodyBytes) {
      response.writeHead(413, { connection: "close" }).end("too large");
      request.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        const piece = chunk as Buffer;
        size += piece.length;
        if (size > SURFACE_LIMITS.bodyBytes) {
          response.writeHead(413, { connection: "close" }).end("too large");
          request.destroy();
          return;
        }
        chunks.push(piece);
      }
    } catch {
      response.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://hub.local");
    const result = await this.handle({ method: request.method ?? "GET", path: url.pathname, headers: request.headers, body: Buffer.concat(chunks) });
    response.writeHead(result.status, { "content-type": result.contentType ?? "text/plain", "cache-control": "no-store", ...(result.headers ?? {}) });
    response.end(result.body);
  }

  /* One request ------------------------------------------------------------------ */

  async handle(request: HubRequest): Promise<HubResponse> {
    try {
      if (request.method === "GET" && request.path === "/health") return { status: 200, body: "ok", contentType: "text/plain" };
      const match = ROUTE.exec(request.path);
      if (!match || request.method !== "POST") return NOT_FOUND;
      const kind = match[1] as CallingSurface;
      let botId: string;
      try {
        botId = decodeURIComponent(match[2] ?? "");
      } catch {
        return NOT_FOUND;
      }
      const view = this.deps.store.get(botId, kind);
      // A surface that is off, unfinished or unknown looks the same as one that never existed.
      if (!view || !view.enabled || view.missing.length > 0) return NOT_FOUND;
      switch (kind) {
        case "webhook":
          return this.webhook(view, request);
        case "email":
          return this.email(view, request);
        case "slack":
          return this.slack(view, request);
        case "teams":
          return await this.teams(view, request);
        default: {
          const unreachable: never = kind;
          throw new Error(`Unhandled surface: ${String(unreachable)}`);
        }
      }
    } catch (error) {
      // The sender is told nothing about what went wrong; the owner can look in the log.
      this.deps.log?.(`surface hub: ${errorText(error)}`);
      return reply(500, { error: "internal" });
    }
  }

  private secret(view: SurfaceView, name: string): string {
    return this.deps.store.secret(view.botId, view.surface, name) ?? "";
  }

  private note(view: SurfaceView, kind: Parameters<ActivityLog["add"]>[2], detail = ""): void {
    this.deps.activity.add(view.botId, view.surface, kind, detail);
  }

  private json(body: Buffer): { ok: true; value: unknown } | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(body.toString("utf8")) as unknown };
    } catch {
      return { ok: false };
    }
  }

  /* Webhook and email: the sender holds a key ------------------------------------ */

  private webhook(view: SurfaceView, request: HubRequest): HubResponse {
    const presented = presentedKey(request.headers);
    const key = this.secret(view, "key");
    if (presented === undefined || key === "" || !safeEqual(presented, key)) {
      this.note(view, "bad-key", "a request without the right key");
      return reply(401, { error: "unauthorized" });
    }
    const raw = request.body.toString("utf8");
    if (raw.trim() === "") return reply(400, { error: "empty" });
    const type = headerOf(request.headers, "content-type") ?? "";
    let text = raw;
    if (/json/i.test(type)) {
      const parsed = this.json(request.body);
      if (!parsed.ok) {
        this.note(view, "malformed", "the body was not JSON");
        return reply(400, { error: "not json" });
      }
      text = JSON.stringify(parsed.value, null, 2);
    }
    const delivery = headerOf(request.headers, "x-deyin-delivery")?.slice(0, 200);
    return this.deliver(view, { senderId: "webhook", senderLabel: "the sender", conversationKey: "webhook", text, ...(delivery ? { deliveryId: `webhook:${delivery}` } : {}) }, null);
  }

  private email(view: SurfaceView, request: HubRequest): HubResponse {
    const secret = this.secret(view, "secret");
    if (secret === "" || !verifyBodySignature(secret, request.body, headerOf(request.headers, "x-deyin-signature"))) {
      this.note(view, "bad-key", "a request that was not signed with the secret");
      return reply(401, { error: "unauthorized" });
    }
    const parsed = this.json(request.body);
    if (!parsed.ok) {
      this.note(view, "malformed", "the body was not JSON");
      return reply(400, { error: "not json" });
    }
    const delivery = parseEmailDelivery(parsed.value);
    if (delivery.kind === "ignore") {
      this.note(view, "malformed", delivery.reason);
      return ack();
    }
    return this.deliver(view, delivery.message, null);
  }

  /* Slack: signed by Slack ---------------------------------------------------------- */

  private slack(view: SurfaceView, request: HubRequest): HubResponse {
    const body = request.body.toString("utf8");
    const signed = verifySlackSignature({
      secret: this.secret(view, "signingSecret"),
      timestamp: headerOf(request.headers, "x-slack-request-timestamp"),
      signature: headerOf(request.headers, "x-slack-signature"),
      body,
      nowMs: this.now(),
    });
    if (!signed) {
      this.note(view, "bad-key", "a request that Slack did not sign, or was too old");
      return reply(401, { error: "unauthorized" });
    }
    const parsed = this.json(request.body);
    if (!parsed.ok) {
      this.note(view, "malformed", "the body was not JSON");
      return reply(400, { error: "not json" });
    }
    const event = parseSlackEvent(parsed.value);
    switch (event.kind) {
      case "challenge":
        return reply(200, { challenge: event.challenge });
      case "ignore":
        return ack();
      case "message": {
        // Slack sends a message again when it did not hear back in time. The event id tells a repeat of one that was taken
        // from one that was turned away (the routine was full): the header alone would lose the second kind.
        const token = this.secret(view, "botToken");
        const send: Sender = async (text) => {
          const call = slackReplyRequest(token, { channel: event.channel, threadTs: event.threadTs, direct: event.direct }, text);
          const response = await this.deps.fetch(call.url, call.init);
          if (!response.ok) return `Slack answered ${response.status}.`;
          return slackReplyFailure(await response.json());
        };
        return this.deliver(view, event.message, send, [token]);
      }
      default: {
        const unreachable: never = event;
        throw new Error(`Unhandled Slack event: ${String(unreachable)}`);
      }
    }
  }

  /* Teams: signed by Microsoft ------------------------------------------------------ */

  private async teams(view: SurfaceView, request: HubRequest): Promise<HubResponse> {
    const parsed = this.json(request.body);
    if (!parsed.ok) {
      this.note(view, "malformed", "the body was not JSON");
      return reply(400, { error: "not json" });
    }
    const authorization = headerOf(request.headers, "authorization") ?? "";
    const token = /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1];
    const serviceUrl = typeof (parsed.value as { serviceUrl?: unknown } | null)?.serviceUrl === "string" ? ((parsed.value as { serviceUrl: string }).serviceUrl) : "";
    if (!token) {
      this.note(view, "bad-key", "a request without a token");
      return reply(401, { error: "unauthorized" });
    }
    let keys;
    try {
      keys = await this.deps.keys.keysFor(tokenKeyId(token));
    } catch (error) {
      this.note(view, "bad-key", `Microsoft's keys could not be fetched: ${errorText(error)}`);
      return reply(503, { error: "unavailable" });
    }
    const checked = verifyBotFrameworkToken(token, { appId: view.settings.appId ?? "", keys, nowMs: this.now(), serviceUrl });
    if (!checked.ok) {
      this.note(view, "bad-key", `a request that Microsoft did not vouch for (${checked.reason})`);
      return reply(401, { error: "unauthorized" });
    }
    const activity = parseTeamsActivity(parsed.value);
    if (activity.kind === "ignore") return ack();
    const appPassword = this.secret(view, "appPassword");
    const target: TeamsTarget = activity.target;
    const send: Sender = async (text) => {
      const bearer = await this.deps.tokens.get({ appId: view.settings.appId ?? "", appPassword, ...(view.settings.tenantId ? { tenant: view.settings.tenantId } : {}) });
      const response = await this.deps.fetch(teamsReplyUrl(target), {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(teamsReplyActivity(target, text)),
      });
      return response.ok ? null : `Teams answered ${response.status}.`;
    };
    return this.deliver(view, activity.message, send, [appPassword]);
  }

  /* After a request has proved itself ------------------------------------------------ */

  /**
   * Everything between "this is really from the service" and "the Bot is asked": who may, whether the routine is on, how
   * often, and whether this is a retry. Then the routine is started and, where the surface has a way back, the answer is
   * sent when the run is over.
   */
  private deliver(view: SurfaceView, partial: Omit<InboundMessage, "botId" | "surface" | "receivedAt">, send: Sender | null, secrets: readonly string[] = []): HubResponse {
    const message: InboundMessage = { ...partial, surface: view.surface, botId: view.botId, receivedAt: this.now() };
    const ids = message.senderAliases && message.senderAliases.length > 0 ? message.senderAliases : message.senderId;
    // A stranger is answered like anyone else would be, with nothing: the list is not something to probe.
    if (!isAllowed(view.surface, ids, view.allow)) {
      this.note(view, "not-allowed", message.senderLabel);
      return ack();
    }
    const routine = this.deps.routines.get(view.routineId);
    if (!routine || routine.botId !== view.botId || !routine.enabled) {
      this.note(view, "routine-off", message.senderLabel);
      return ack();
    }
    const delivery = message.deliveryId ? `${view.botId}\u0000${message.deliveryId}` : undefined;
    if (delivery && this.dedupe.has(delivery)) {
      this.note(view, "duplicate", message.senderLabel);
      return ack();
    }
    if (!this.rate.take(`${view.botId}\u0000${view.surface}`)) {
      this.note(view, "rate-limited", message.senderLabel);
      return { status: 429, body: JSON.stringify({ error: "slow down" }), contentType: "application/json", headers: { "retry-after": "60" } };
    }
    if (delivery) this.dedupe.first(delivery);
    const thread = conversationId(message);
    const history = view.surface === "webhook" ? [] : this.conversations.recent(thread);
    let run: { id: string };
    try {
      run = this.deps.invoke(routine.id, inboundPrompt(message, history));
    } catch (error) {
      // The message was not taken, so a retry of it is welcome later.
      if (delivery) this.dedupe.forget(delivery);
      if (error instanceof RoutineBusyError) {
        this.note(view, "busy", message.senderLabel);
        return { status: 429, body: JSON.stringify({ error: "busy" }), contentType: "application/json", headers: { "retry-after": "60" } };
      }
      this.note(view, "run-failed", redact(errorText(error), secrets));
      return reply(500, { error: "could not start" });
    }
    this.note(view, "accepted", message.senderLabel);
    if (view.surface !== "webhook") this.conversations.add(thread, { role: "person", text: message.text });
    if (!send) return reply(202, { ok: true, runId: run.id });
    this.track(this.answer(view, run.id, thread, send, secrets));
    return ack();
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch(() => undefined).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /** Wait for the run, then say what the Bot said. A run that failed is told as a short apology and no more: why is for the owner. */
  private async answer(view: SurfaceView, runId: string, thread: string, send: Sender, secrets: readonly string[]): Promise<void> {
    const end = await this.deps.settled(runId);
    let text: string;
    switch (end.status) {
      case "completed":
        text = end.reply;
        if (text === "") {
          this.note(view, "run-failed", "the Bot finished with nothing to say");
          return;
        }
        break;
      case "failed":
        this.note(view, "run-failed", redact(end.reason ?? "failed", secrets));
        text = FAILED_REPLY;
        break;
      case "aborted":
        this.note(view, "run-failed", end.reason ?? "stopped");
        return;
      case "queued":
      case "running":
        return;
      default: {
        const unreachable: never = end.status;
        throw new Error(`Unhandled run status: ${String(unreachable)}`);
      }
    }
    const fitted = fitReply(text);
    let problem: string | null;
    try {
      problem = await send(fitted);
    } catch (error) {
      problem = errorText(error);
    }
    if (problem !== null) {
      this.note(view, "reply-failed", redact(problem, secrets));
      return;
    }
    if (end.status === "completed") this.conversations.add(thread, { role: "bot", text: fitted });
    this.note(view, "replied", "");
  }
}
