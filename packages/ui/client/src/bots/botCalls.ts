import type { BotResult } from "@deyin/contract";

/** What a panel gets back from the host: the value, or words saying why not. Never a throw. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run a host call that answers with a `BotResult`, and turn a refusal or a failed call into an `Outcome`. */
export async function attempt<T>(run: () => Promise<BotResult<T>>): Promise<Outcome<T>> {
  try {
    const result = await run();
    return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}

/** Run a host call that answers with a plain value. */
export async function attemptPlain<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}
