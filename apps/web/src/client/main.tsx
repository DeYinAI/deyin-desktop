import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { cssVariables } from "@deyin/branding";
import { App } from "@renderer/app.js";
import "@renderer/styles.css";
import { createBrowserTransport, maybeCompleteLogin } from "./transport.js";

async function main() {
  // If we're on the OAuth callback route, finish the exchange and return home.
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
