import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;

// The web client reuses the desktop renderer source verbatim (one UI, two runtimes).
export default defineConfig({
  root,
  esbuild: {
    // Use the automatic JSX runtime (import { jsx } from "react/jsx-runtime") instead of
    // the classic React.createElement, which would require an explicit React import.
    jsx: "automatic",
    jsxImportSource: "react",
  },
  server: {
    port: 5273,
    proxy: {
      // Host-server: model proxy over HTTP, host services over WebSocket.
      "/api": { target: "http://localhost:8790", changeOrigin: true },
      "/host": { target: "ws://localhost:8790", ws: true },
    },
  },
  build: { outDir: "dist/client" },
});
