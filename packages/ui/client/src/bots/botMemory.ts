import type { BotMemoryFactView } from "@deyin/host-core/shared";

/** Private facts first (they are this Bot's own), then shared ones; newest first inside each group. */
export function orderMemory(facts: readonly BotMemoryFactView[]): BotMemoryFactView[] {
  return [...facts].sort((a, b) => {
    if (a.shared !== b.shared) return a.shared ? 1 : -1;
    return b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name);
  });
}
