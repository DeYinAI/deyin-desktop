import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const root = import.meta.dirname;

// Bundle workspace packages into the main output; keep native/third-party deps external.
const externalize = externalizeDepsPlugin({
 exclude: ["@deyin/oauth-client", "@deyin/branding", "@deyin/host-core", "@deyin/agent-core", "@deyin/optimization-plugin"],
 });

export default defineConfig({
  main: {
    plugins: [externalize],
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
        external: ["node-pty", "@huggingface/transformers", "onnxruntime-node"],
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
