import {
  BotError,
  ConversationLog,
  DeliveryDedupe,
  RateWindow,
  conversationId,
  fitPost,
  inboundPrompt,
  isAllowed,
  parseXMentions,
  xMentionsRequest,
  type ActivityLog,
  type HttpFetch,
  type InboundMessage,
  type Outbox,
  type SurfaceStore,
  type SurfaceView,
  type XCursors,
} from "@deyin/host-core";
import { RoutineBusyError } from "../automations/runner.js";
import type { RunEnd } from "./run-watch.js";

export interface XPollerDeps {
  store: Pick<SurfaceStore, "active" | "secret" | "onChange">;
  routines: { get(routineId: string): { id: string; botId?: string; enabled: boolean } | undefined };
  invoke(routineId: string, text: string): { id: string };
  settled(runId: string): Promise<RunEnd>;
  outbox: Pick<Outbox, "add">;
  cursors: Pick<XCursors, "get" | "set">;
  fetch: HttpFetch;
  activity: ActivityLog;
  now?: () => number;
  /** How often X is asked. */
  intervalMs?: number;
  /** How long to leave X alone after it says to slow down. */
  backoffMs?: number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

const DEFAULT_INTERVAL_MS = 2 * 60_000;
const DEFAULT_BACKOFF_MS = 15 * 60_000;
const FIRST_MARK = "1";
const X_REPLY_NOTE = "Your answer will be a public reply on X, which holds 280 characters at most. Keep it short, and do not put anything in it that you would not want everyone to read.";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(message: string, secret: string): string {
  return secret.length >= 4 ? message.split(secret).join("•••") : message;
}

/**
 * X does not call the app, so the app asks: every couple of minutes it reads the Bot's mentions, hands each one from
 * someone on the list to the routine, and puts what the Bot says into the Outbox. It never posts: a post leaves only
 * when a person approves that exact text. The first read of a Bot only marks the place, so turning X on does not answer
 * everything anyone ever said to the account.
 */
export class XPoller {
  private readonly conversations = new ConversationLog();
  private readonly dedupe: DeliveryDedupe;
  private readonly rate: RateWindow;
  private readonly background = new Set<Promise<void>>();
  private readonly pausedUntil = new Map<string, number>();
  private polling: Promise<void> | null = null;
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: XPollerDeps) {
    this.now = deps.now ?? Date.now;
    this.dedupe = new DeliveryDedupe(this.now);
    this.rate = new RateWindow(this.now);
  }

  start(): void {
    if (this.timer !== null) return;
    const timers = this.deps.timers ?? { set: (fn, ms) => setInterval(fn, ms).unref(), clear: (handle) => clearInterval(handle as NodeJS.Timeout) };
    this.timer = timers.set(() => void this.pollNow(), this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    // A Bot turned on is marked at once, so what is said to it from now on is answered rather than skipped as history.
    this.unsubscribe = this.deps.store.onChange(() => void this.pollNow({ onlyUnmarked: true }));
    void this.pollNow({ onlyUnmarked: true });
  }

  stop(): void {
    if (this.timer !== null) (this.deps.timers?.clear ?? ((handle) => clearInterval(handle as NodeJS.Timeout)))(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Resolves when everything started so far has finished, including the drafts waiting on a run. */
  async idle(): Promise<void> {
    await this.polling;
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  forgetBot(botId: string): void {
    this.conversations.forgetBot(botId);
    this.pausedUntil.delete(botId);
  }

  /** Read every active X surface once. A read already going is not started again. */
  pollNow(options: { onlyUnmarked?: boolean } = {}): Promise<void> {
    if (this.polling) return this.polling;
    const run = this.pollAll(options).finally(() => {
      if (this.polling === run) this.polling = null;
    });
    this.polling = run;
    return run;
  }

  private async pollAll(options: { onlyUnmarked?: boolean }): Promise<void> {
    for (const view of this.deps.store.active()) {
      if (view.surface !== "x") continue;
      if (options.onlyUnmarked && this.deps.cursors.get(view.botId) !== undefined) continue;
      try {
        await this.pollOne(view);
      } catch (error) {
        this.deps.activity.add(view.botId, "x", "poll-failed", this.scrub(view, errorText(error)));
      }
    }
  }

  /** Words for the owner's log with the Bot's access token taken out, whatever put it there. */
  private scrub(view: SurfaceView, message: string): string {
    return redact(message, this.deps.store.secret(view.botId, "x", "accessToken") ?? "");
  }

  private async pollOne(view: SurfaceView): Promise<void> {
    const until = this.pausedUntil.get(view.botId);
    if (until !== undefined && until > this.now()) return;
    const token = this.deps.store.secret(view.botId, "x", "accessToken");
    const userId = view.settings.userId;
    if (!token || !userId) return;
    const cursor = this.deps.cursors.get(view.botId);
    const call = xMentionsRequest(token, userId, cursor);
    const response = await this.deps.fetch(call.url, call.init);
    if (response.status === 429) {
      this.pausedUntil.set(view.botId, this.now() + (this.deps.backoffMs ?? DEFAULT_BACKOFF_MS));
      this.deps.activity.add(view.botId, "x", "poll-failed", "X says too many requests were made; waiting a while before asking again");
      return;
    }
    if (!response.ok) {
      this.deps.activity.add(view.botId, "x", "poll-failed", `X answered ${response.status}${response.status === 401 || response.status === 403 ? ": check the access token and what it may do" : ""}`);
      return;
    }
    const read = parseXMentions(await response.json(), userId);
    if (cursor === undefined) {
      // The first read only marks the place. With no mentions at all there is nothing to mark, and the smallest id stands for "everything after now".
      this.deps.cursors.set(view.botId, read.newestId ?? FIRST_MARK);
      return;
    }
    let handled: string | undefined;
    let stoppedEarly = false;
    for (const mention of read.mentions) {
      const outcome = this.take(view, mention.tweetId, mention.author, mention.message);
      if (outcome === "stop") {
        stoppedEarly = true;
        break;
      }
      handled = mention.tweetId;
    }
    // Everything read is dealt with unless the routine was full; then the rest is read again next time.
    const mark = stoppedEarly ? handled : (read.newestId ?? handled);
    if (mark !== undefined) this.deps.cursors.set(view.botId, mark);
  }

  /** One mention: let in, started, or turned away. "stop" means the routine is full and this one must be read again. */
  private take(view: SurfaceView, tweetId: string, author: string, partial: Omit<InboundMessage, "botId" | "surface" | "receivedAt">): "done" | "stop" {
    const note = (kind: Parameters<ActivityLog["add"]>[2], detail: string): void => this.deps.activity.add(view.botId, "x", kind, detail);
    const message: InboundMessage = { ...partial, surface: "x", botId: view.botId, receivedAt: this.now() };
    if (!isAllowed("x", message.senderAliases && message.senderAliases.length > 0 ? message.senderAliases : message.senderId, view.allow)) {
      note("not-allowed", message.senderLabel);
      return "done";
    }
    const routine = this.deps.routines.get(view.routineId);
    if (!routine || routine.botId !== view.botId || !routine.enabled) {
      note("routine-off", message.senderLabel);
      return "done";
    }
    const delivery = `${view.botId}\u0000${message.deliveryId ?? tweetId}`;
    if (this.dedupe.has(delivery)) {
      note("duplicate", message.senderLabel);
      return "done";
    }
    if (!this.rate.take(`${view.botId}\u0000x`)) {
      note("rate-limited", message.senderLabel);
      return "stop";
    }
    this.dedupe.first(delivery);
    const thread = conversationId(message);
    let run: { id: string };
    try {
      run = this.deps.invoke(routine.id, `${inboundPrompt(message, this.conversations.recent(thread))}\n${X_REPLY_NOTE}`);
    } catch (error) {
      this.dedupe.forget(delivery);
      if (error instanceof RoutineBusyError) {
        note("busy", message.senderLabel);
        return "stop";
      }
      note("run-failed", this.scrub(view, errorText(error)));
      return "done";
    }
    note("accepted", message.senderLabel);
    this.conversations.add(thread, { role: "person", text: message.text });
    const work = this.draft(view, run.id, tweetId, author, message.text).catch(() => undefined);
    const tracked = work.finally(() => this.background.delete(tracked));
    this.background.add(tracked);
    return "done";
  }

  /** When the run is over, put what the Bot said in the Outbox as a draft. Nothing is posted. */
  private async draft(view: SurfaceView, runId: string, tweetId: string, author: string, context: string): Promise<void> {
    const end = await this.deps.settled(runId);
    const note = (kind: Parameters<ActivityLog["add"]>[2], detail: string): void => this.deps.activity.add(view.botId, "x", kind, detail);
    if (end.status !== "completed") {
      // A public account is never answered with an apology the person did not write.
      note("run-failed", this.scrub(view, end.reason ?? end.status));
      return;
    }
    if (end.reply === "") {
      note("run-failed", "the Bot finished with nothing to say");
      return;
    }
    try {
      this.deps.outbox.add({ botId: view.botId, inReplyTo: tweetId, context, author, text: fitPost(end.reply) });
    } catch (error) {
      if (error instanceof BotError && error.code === "conflict") {
        note("duplicate", `a reply to ${author} is already waiting or posted`);
        return;
      }
      note("run-failed", this.scrub(view, errorText(error)));
      return;
    }
    note("drafted", `a reply to ${author} is waiting for you in the Outbox`);
  }
}
