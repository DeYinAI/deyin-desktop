import { resolve } from "node:path";
import { cpSync, existsSync } from "node:fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

const root = import.meta.dirname;

function copyMcpCatalogPlugin(): Plugin {
  const copy = () => {
    const src = resolve(root, "src/main/mcp-catalog");
    const dest = resolve(root, "out/main/mcp-catalog");
    if (existsSync(src)) cpSync(src, dest, { recursive: true });
  };
  return {
    name: "copy-mcp-catalog",
    buildStart() {
      copy();
    },
    closeBundle() {
      copy();
    },
  };
}

function copyBundledPluginsPlugin(): Plugin {
  const copy = () => {
    const src = resolve(root, "bundled-plugins");
    const dest = resolve(root, "out/main/bundled-plugins");
    if (existsSync(src)) cpSync(src, dest, { recursive: true });
  };
  return {
    name: "copy-bundled-plugins",
    buildStart() {
      copy();
    },
    closeBundle() {
      copy();
    },
  };
}

/**
 * Remove `crossorigin` attributes from built HTML to prevent CORS failures
 * when loading assets over file:// protocol in Electron on Windows.
 * 
 * Vite adds crossorigin="anonymous" to <script> and <link> tags in production.
 * Chromium treats file:// URLs with crossorigin as CORS requests, which fail
 * silently (no CORS headers available), causing a blank screen on Windows.
 */
function removeCrossOriginPlugin(): Plugin {
  return {
    name: "remove-crossorigin",
    enforce: "post",
    transformIndexHtml(html) {
      return html
        .replace(/\s+crossorigin/g, "")
        .replace(/crossorigin\s+/g, "");
    },
  };
}

// Bundle workspace packages into the main output; keep native/third-party deps external.
const externalize = externalizeDepsPlugin({
  exclude: [
    "@deyin/oauth-client",
    "@deyin/branding",
    "@deyin/host-core",
    "@deyin/agent-core",
    "@deyin/contract",
    "@deyin/extension-api",
    "@deyin/kernel",
    "@deyin/tools",
    "@deyin/llm",
    "@deyin/bundle-base",
    "@deyin/bundle-desktop-app",
    "@deyin/optimization-plugin",
  ],
});

// The renderer SPA lives in @deyin/ui (packages/ui/client) and is shared with
// the web app; only the entry html and transport are desktop-specific.
const rendererRoot = resolve(root, "../../packages/ui/client");

export default defineConfig({
  main: {
    plugins: [externalize, copyMcpCatalogPlugin(), copyBundledPluginsPlugin()],
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: resolve(root, "src/main/index.ts"),
        // node-pty lives in optionalDependencies, which externalizeDepsPlugin
        // does not read; without this rollup would inline its JS with a
        // throwing require() stub and the native pty.node/conpty.node could
        // never load in packaged builds. Kept external, the runtime
        // import("node-pty") resolves from node_modules (asar-unpacked).
        // @huggingface/transformers is the *optional* ONNX embedding backend
        // (dynamically imported by host-core's indexer); external so its
        // absence never breaks the bundle.
        external: ["node-pty", "@huggingface/transformers", "onnxruntime-node", "playwright-core", "kerberos"],
      },
    },
  },
  preload: {
    plugins: [externalize],
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: resolve(root, "src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: rendererRoot,
    plugins: [react(), removeCrossOriginPlugin()],
    build: {
      outDir: resolve(root, "out/renderer"),
      rollupOptions: {
        input: resolve(rendererRoot, "index.html"),
        output: {
          manualChunks: (id) => {
            if (id.includes("node_modules")) {
              if (id.includes("@xterm")) return "xterm";
              if (id.includes("react-markdown") || id.includes("remark") || id.includes("unified") || id.includes("micromark") || id.includes("mdast") || id.includes("hast")) return "markdown";
              if (id.includes("react") || id.includes("scheduler")) return "react";
              return "vendor";
            }
            return undefined;
          },
        },
      },
    },
  },
});
