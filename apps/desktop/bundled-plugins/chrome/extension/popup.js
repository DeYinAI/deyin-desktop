// Popup for the Deyin Browser Bridge. All state lives in the service worker;
// this file only renders it and forwards button presses. Page titles and URLs
// are untrusted, so everything is written with textContent.

const $ = (id) => document.getElementById(id);

function command(cmd, extra = {}) {
  return chrome.runtime.sendMessage({ cmd, ...extra });
}

function describe(state) {
  if (!state.enabled) return { text: "Disconnected. Deyin can't reach this browser.", dot: "" };
  if (state.stopped) {
    return {
      text: state.stoppedBy === "extension" ? "Stopped. Deyin can't use any tab until you resume." : "Stopped from Deyin.",
      dot: "stop",
    };
  }
  switch (state.link) {
    case "connected": {
      const parts = [];
      if (state.agentTabs) parts.push(`${state.agentTabs} Deyin tab${state.agentTabs === 1 ? "" : "s"}`);
      if (state.sharedTabs) parts.push(`${state.sharedTabs} shared`);
      return { text: parts.length ? `Connected to Deyin · ${parts.join(", ")}` : "Connected to Deyin. No tabs in use.", dot: "on" };
    }
    case "pairing_confirm":
      return { text: "Deyin wants to pair with this browser.", dot: "warn" };
    case "pairing_wait":
      return { text: "Pairing with Deyin…", dot: "warn" };
    default:
      return {
        text: state.paired ? "Waiting for Deyin to open…" : "Not paired. In Deyin, open Settings → Chrome and choose Pair Chrome.",
        dot: "",
      };
  }
}

function render(state) {
  const { text, dot } = describe(state);
  $("status").textContent = text;
  $("dot").className = `dot ${dot}`;

  $("pair").hidden = !(state.link === "pairing_confirm" && state.code);
  $("code").textContent = state.code || "";

  const connected = state.link === "connected" && state.enabled;
  const tab = state.activeTab;
  $("tab").hidden = !(connected && tab);
  if (connected && tab) {
    $("tab-title").textContent = tab.title || tab.url || "(untitled)";
    $("tab-note").textContent = tab.agent
      ? "Opened by Deyin."
      : tab.reason || (tab.shared ? "Deyin can read and control this tab." : "Deyin can't see this tab unless you share it.");
    const share = $("share");
    share.textContent = tab.shared ? "Stop sharing this tab" : "Share this tab with Deyin";
    share.disabled = !tab.shared && !tab.canShare;
  }

  $("actions").hidden = !(connected && !state.stopped);
  $("close-tabs").disabled = !state.agentTabs;
  $("resume").hidden = !(state.stopped && state.stoppedBy === "extension");

  $("toggle").textContent = state.enabled ? "Disconnect" : "Connect";
  $("forget").hidden = !state.paired;
}

async function refresh() {
  const state = await command("get-status");
  if (state && !state.error) render(state);
}

async function act(cmd, extra) {
  const state = await command(cmd, extra);
  if (state && !state.error) render(state);
}

$("allow").addEventListener("click", () => act("allow"));
$("deny").addEventListener("click", () => act("deny"));
$("share").addEventListener("click", () => act("share-active"));
$("stop").addEventListener("click", () => act("stop"));
$("resume").addEventListener("click", () => act("resume"));
$("close-tabs").addEventListener("click", () => act("close-agent-tabs"));
$("toggle").addEventListener("click", async () => {
  const state = await command("get-status");
  await act("set-enabled", { enabled: !state.enabled });
});
$("forget").addEventListener("click", () => act("forget"));

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.cmd === "status-changed") refresh();
});

refresh();
