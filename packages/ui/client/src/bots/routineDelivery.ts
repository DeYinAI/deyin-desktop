import type { AutomationRun } from "@deyin/contract";
import { addBotThread, botThreads, type Project, type Thread } from "@deyin/host-core/shared";
import { fill } from "../automationFormat.js";
import { emptyThread } from "../threads.js";

/** What the conversation needs to know about a finished run. */
export type FinishedRun = Pick<AutomationRun, "status" | "finalText" | "reason">;

/** The words around a result, already in the person's language. `{name}` and `{reason}` are filled in. */
export interface DeliveryWords {
  posted: string;
  failed: string;
  noReason: string;
}

export interface RoutineDelivery {
  /** The Bot the routine belongs to. */
  botId: string;
  /** The routine's name. */
  name: string;
  run: FinishedRun;
  words: DeliveryWords;
  /** The conversation the person is looking at, which is not marked unread. */
  activeThreadId: string | null;
  now: number;
}

/**
 * What a Bot says in its conversation when one of its routines has finished: the result under the routine's
 * name, or what went wrong. Nothing for a run that was stopped or has not finished, or a finished one with
 * nothing to say: there is no point in a message that says nothing.
 */
export function routineMessage(name: string, run: FinishedRun, words: DeliveryWords): string | null {
  if (run.status === "completed") {
    const text = (run.finalText ?? "").trim();
    return text ? `**${fill(words.posted, { name })}**\n\n${text}` : null;
  }
  if (run.status === "failed") {
    return fill(words.failed, { name, reason: (run.reason ?? "").trim() || words.noReason });
  }
  return null;
}

/**
 * Put a routine's result in its Bot's newest conversation (or start one, named for the routine, when the Bot has
 * none), marked unread unless that is the conversation being looked at. Null when there is nothing to put there.
 * A routine runs with nobody in the chat, so this is how its result reaches the person.
 */
export function deliverRoutineResult(projects: readonly Project[], delivery: RoutineDelivery): Project[] | null {
  const text = routineMessage(delivery.name, delivery.run, delivery.words);
  if (text === null) return null;
  const target = botThreads(projects, delivery.botId)[0];
  if (!target) {
    const created: Thread = {
      ...emptyThread(delivery.name),
      mode: "agent",
      botId: delivery.botId,
      updatedAt: delivery.now,
      unread: true,
      events: [{ kind: "assistant", text }],
    };
    return addBotThread(projects, created);
  }
  return projects.map((project) => ({
    ...project,
    threads: project.threads.map((thread) =>
      thread.id === target.id
        ? { ...thread, events: [...thread.events, { kind: "assistant" as const, text }], updatedAt: delivery.now, unread: thread.id !== delivery.activeThreadId }
        : thread,
    ),
  }));
}
