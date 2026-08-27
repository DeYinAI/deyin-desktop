/** True for the hosted chat.openference.com build (no host-server / agent tools). */
export function isChatOnlyHosted(): boolean {
  return import.meta.env.VITE_DEYIN_CHAT_ONLY === "true";
}
