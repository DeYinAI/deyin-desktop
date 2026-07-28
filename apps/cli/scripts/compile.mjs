/**
 * Compile the CLI into a single self-contained executable with Bun.
 *
 *   bun scripts/compile.mjs <bun-target> <outfile>
 *   e.g. bun scripts/compile.mjs bun-linux-x64 dist-bin/deyin-linux-x64
 *
 * Ink's reconciler dynamically imports `react-devtools-core` behind a DEV check; the
 * bundler hoists that external import to the bundle root, which breaks the compiled
 * binary at startup. Stub the module instead — devtools are meaningless in a release
 * binary anyway.
 */
const [target, outfile] = process.argv.slice(2);
if (!target || !outfile) {
  console.error("usage: bun scripts/compile.mjs <bun-target> <outfile>");
  process.exit(1);
}

const stubDevtools = {
  name: "stub-react-devtools-core",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default { connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

// Compiled binaries have no package.json next to them, so bake the version in.
const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  plugins: [stubDevtools],
  define: {
    "process.env.DEV": '"false"',
    "process.env.DEYIN_BUILD_VERSION": JSON.stringify(pkg.version),
  },
  compile: { target, outfile },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outfile} (${target})`);
