import type { ToolContext } from "@deyin/agent-core";
import type { CdpPage } from "../../../bundled-plugins/browser/host/cdp-page.js";
import type { VaultPage, VaultPageSource } from "./vault-tools.js";

/** The part of a page driver the Vault needs. */
type Driver = Pick<CdpPage, "info" | "fill" | "press">;

/**
 * A page driver seen the way the Vault tools use it. The driver's own `fill` answers with the text it typed, so that
 * answer is dropped here: a secret must never come back out through the tool that put it in.
 */
export function vaultPageOf(page: Driver): VaultPage {
  return {
    url: async () => (await page.info()).url,
    fill: async (ref, value) => {
      await page.fill(ref, value);
    },
    submit: async () => {
      await page.press("Enter");
    },
  };
}

/** The in-app browser. */
export function browserPageSource(browser: { withPage<T>(fn: (page: CdpPage) => Promise<T>): Promise<T> }): VaultPageSource {
  return { withPage: (_ctx, fn) => browser.withPage((page) => fn(vaultPageOf(page))) };
}

/** The user's own Chrome, through the Deyin extension: the Bot's current tab for this conversation. */
export function chromePageSource(chrome: {
  withPage<T>(threadId: string | undefined, tabId: number | undefined, action: string, fn: (page: CdpPage) => Promise<T>, opts?: { signal?: AbortSignal }): Promise<T>;
}): VaultPageSource {
  return {
    withPage: (ctx: ToolContext, fn) =>
      chrome.withPage(ctx.sessionMeta?.threadId, undefined, "fill", (page) => fn(vaultPageOf(page)), { ...(ctx.signal ? { signal: ctx.signal } : {}) }),
  };
}
