import type { UpdatesState } from "@deyin/contract";
import type { MessageKey } from "@deyin/host-core/shared";

type Translate = (key: MessageKey) => string;

/** Replace `{name}` placeholders in a translated template. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ""));
}

/**
 * One-line text for the update pill, or null when the updater state has nothing
 * to show. Exhaustive on purpose: a status added to the contract without a case
 * here fails to compile, instead of silently rendering as "Could not update".
 */
export function updateBannerMessage(state: UpdatesState, t: Translate): string | null {
  const version = state.availableVersion ?? "";
  switch (state.status) {
    case "idle":
    case "checking":
    case "not-available":
    case "unsupported":
      return null;
    case "available":
      return fill(t("update.available"), { version });
    case "downloading":
      return fill(t("update.downloading"), { version, percent: state.progressPercent ?? 0 });
    case "downloaded":
      return fill(t("update.downloaded"), { version });
    case "installing":
      return fill(t("update.installing"), { version });
    case "error":
      return fill(t("update.error"), { message: state.error ?? "unknown" });
    default: {
      const _exhaustive: never = state.status;
      void _exhaustive;
      return null;
    }
  }
}
