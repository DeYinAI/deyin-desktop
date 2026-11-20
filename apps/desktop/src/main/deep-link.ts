import { isTemplateLink } from "@deyin/host-core";

/** The longest import link taken from outside. A link made by Deyin is far shorter; this only stops absurd ones. */
export const MAX_IMPORT_LINK = 50_000;

/** Where a `deyin://` link goes. */
export type DeepLinkRoute =
  /** Someone shared a Bot: ask the person whether to add it. Nothing is added by the link itself. */
  | { kind: "bot-import"; link: string }
  /** Anything else is the sign-in handler's, as it always was. */
  | { kind: "auth"; url: string };

export function routeDeepLink(url: string | undefined): DeepLinkRoute | null {
  if (!url) return null;
  if (isTemplateLink(url)) return url.length <= MAX_IMPORT_LINK ? { kind: "bot-import", link: url.trim() } : null;
  return { kind: "auth", url };
}

/**
 * A shared Bot waiting for the person to look at it. A link that opened the app arrives before the window can show
 * anything, so it is kept until the window asks. Only the newest is kept, and it is handed over once.
 */
export class PendingImport {
  private link: string | null = null;

  offer(link: string): void {
    this.link = link;
  }

  take(): string | null {
    const link = this.link;
    this.link = null;
    return link;
  }
}
