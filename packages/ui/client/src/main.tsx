import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { cssVariables } from "@deyin/branding";
import { App } from "./app.js";
import "./styles.css";

// Inject brand tokens as CSS variables so styles.css can reference them.
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
