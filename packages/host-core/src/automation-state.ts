import type { Storage } from "./storage.js";

/**
 * What an automation carries from one run to the next.
 *
 * A scheduled run starts with no memory of the last one, so an automation that
 * must not repeat itself (a posting bot, a digest) had nowhere to keep "what I
 * already did" except free-text notes the whole app could read and that
 * contradicted each other. This is one small JSON object per automation, owned
 * by that automation alone and handed back to it at the start of every run.
 */

export const MAX_STATE_BYTES = 8 * 1024;

/** What is wrong with a proposed state, or null when it can be stored. */
export function stateError(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "State must be a JSON object, e.g. {\"lastPostedAt\": \"...\"}.";
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return "State must be plain JSON.";
  }
  if (size > MAX_STATE_BYTES) {
    return `State is ${size} bytes; the limit is ${MAX_STATE_BYTES}. Keep only what the next run needs.`;
  }
  return null;
}

interface StateFile {
  states: Record<string, Record<string, unknown>>;
}

export class AutomationStateStore {
  private readonly file: StateFile;

  constructor(private readonly storage: Storage) {
    const raw = storage.readJson<StateFile>("automation-state.json", { states: {} });
    this.file = { states: raw && typeof raw.states === "object" && raw.states ? raw.states : {} } as StateFile;
  }

  get(automationId: string): Record<string, unknown> | undefined {
    return this.file.states[automationId];
  }

  /** Replaces the whole state. Throws a message the caller can show when it cannot be stored. */
  set(automationId: string, value: unknown): void {
    const problem = stateError(value);
    if (problem) throw new Error(problem);
    this.file.states[automationId] = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    this.storage.writeJson("automation-state.json", this.file);
  }

  remove(automationId: string): void {
    if (!(automationId in this.file.states)) return;
    delete this.file.states[automationId];
    this.storage.writeJson("automation-state.json", this.file);
  }
}
