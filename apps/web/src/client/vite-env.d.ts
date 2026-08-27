/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEYIN_OAUTH_ISSUER?: string;
  readonly VITE_DEYIN_CLIENT_ID?: string;
  /** When "true", skip host-server; plain chat via /api proxy only. */
  readonly VITE_DEYIN_CHAT_ONLY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
