import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { cssVariables } from "@deyin/branding";
import { App } from "@deyin/ui";
import "@deyin/ui/styles.css";
import { createBrowserTransport, maybeCompleteLogin } from "./transport.js";
import { maybeBootstrapSsoSession } from "./sso-session.js";

async function main() {
  await maybeBootstrapSsoSession();
  await maybeCompleteLogin();

  // Provide the same API the desktop preload exposes, backed by WebSocket + HTTP.
  window.deyin = createBrowserTransport();

  const style = document.createElement("style");
  style.textContent = cssVariables();
  document.head.appendChild(style);

  // Start in dark before React mounts; the App effect re-applies the saved setting.
  document.documentElement.dataset.theme ||= "dark";

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
