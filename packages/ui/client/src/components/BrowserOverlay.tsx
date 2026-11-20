import { useEffect, useState } from "react";
import type { ChromeBridgeStatus } from "@deyin/contract";

const agentTabCount = (status: ChromeBridgeStatus): number => status.tabs.filter((tab) => tab.kind === "agent").length;

/**
 * Banners for browser automation: the in-app browser (browser_* tools) and the user's real Chrome
 * (chrome_* tools, through the extension). Chrome's own indicator is the Deyin tab group; this is the in-app
 * side of it, with the tab count and a Stop that detaches from every tab.
 */
export function BrowserOverlay() {
  const [inAppActive, setInAppActive] = useState(false);
  const [chromeActive, setChromeActive] = useState(false);
  const [chromeTabs, setChromeTabs] = useState(0);

  useEffect(() => window.deyin.browserControl.onActive(setInAppActive), []);

  useEffect(() => {
    const chrome = window.deyin.chrome;
    if (!chrome) return undefined;
    const offActive = chrome.onActive(setChromeActive);
    const offStatus = chrome.onStatus((status) => setChromeTabs(agentTabCount(status)));
    void chrome.getStatus().then((status) => setChromeTabs(agentTabCount(status)));
    return () => {
      offActive();
      offStatus();
    };
  }, []);

  return (
    <>
      {inAppActive && (
        <div className="activity-banner activity-banner--browser" role="status" aria-live="polite">
          <span className="activity-banner__text">Deyin is using the browser</span>
        </div>
      )}
      {chromeActive && (
        <div className="activity-banner activity-banner--browser" role="status" aria-live="polite">
          <span className="activity-banner__text">
            Deyin is working in your Chrome
            {chromeTabs > 0 ? ` · ${chromeTabs} tab${chromeTabs === 1 ? "" : "s"}` : ""}
          </span>
          <button
            type="button"
            className="activity-banner__btn activity-banner__btn--stop"
            title="Stop and detach from every tab"
            onClick={() => void window.deyin.chrome?.stop()}
          >
            Stop
          </button>
        </div>
      )}
    </>
  );
}
