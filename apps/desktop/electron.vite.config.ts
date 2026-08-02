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

// Bundle workspace packages into the main output; keep native/third-party deps external.
const externalize = externalizeDepsPlugin({
 exclude: ["@deyin/oauth-client", "@deyin/branding", "@deyin/host-core", "@deyin/agent-core", "@deyin/computer-use-host", "@deyin/optimization-plugin"],
 });

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
    root: resolve(root, "src/renderer"),
    plugins: [react()],
    build: {
      outDir: "out/renderer",
      rollupOptions: { input: resolve(root, "src/renderer/index.html") },
    },
  },
});
